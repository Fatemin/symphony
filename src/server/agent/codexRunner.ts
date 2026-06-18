import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { log } from '../observability/logger';
import type { PermissionMode } from '../core/config';
import { classifyAgentError } from './claudeRunner';
import type { AgentErrorKind, AgentEvent, AgentResult, AgentRunInput, AgentRunner, AgentUsage } from './types';

// Raw shape of a Codex CLI `exec --json` (JSONL) line. The CLI emits one JSON object per line;
// most carry a nested `msg` whose `type` discriminates the event. The schema is version-specific,
// so every field is optional and parsing is defensive — unknown lines are ignored, never fatal.
interface CodexLine {
  id?: string;
  type?: string;
  msg?: CodexMsg;
  // Some builds flatten the event onto the top level instead of nesting under `msg`.
  session_id?: string;
  thread_id?: string;
}

interface CodexMsg {
  type?: string;
  // session_configured
  session_id?: string;
  model?: string;
  // agent_message / error
  message?: string;
  text?: string;
  // task_complete
  last_agent_message?: string;
  // exec_command_begin
  command?: unknown;
  // exec_command_end
  stdout?: string;
  stderr?: string;
  // token_count
  info?: CodexTokenInfo | null;
}

interface CodexUsageCounts {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenInfo {
  total_token_usage?: CodexUsageCounts;
  last_token_usage?: CodexUsageCounts;
}

/**
 * Real agent runner for the Codex CLI. Spawns `codex exec --json` headlessly, feeds the prompt
 * over stdin (so its contents never pass through shell quoting), parses the streamed JSONL into
 * normalized AgentEvents, and resolves with the final result. Conforms to `AgentRunner`.
 *
 * The worktree is already an isolated git checkout (Safety Invariant §9.5), so we run Codex
 * non-interactively with a sandbox/approval policy mapped from Symphony's permission_mode — no
 * human can answer an approval prompt mid-run. Codex's resume story differs from Claude's (it is
 * a `codex exec resume <id>` subcommand, not a flag), so resumeSessionId is intentionally ignored
 * here: each phase starts a fresh session. classifyAgentError is shared with claudeRunner.
 */
export const runCodex: AgentRunner = (input: AgentRunInput, onEvent) =>
  new Promise<AgentResult>((resolve) => {
    const started = Date.now();
    const args = ['exec', '--json', '-m', input.model, ...sandboxArgs(input.permissionMode)];
    // `-` tells `codex exec` to read the prompt from stdin instead of taking it as an argument.
    args.push('-');

    const emit = (e: AgentEvent) => {
      try {
        onEvent?.(e);
      } catch (err) {
        log.warn('onEvent threw', { err: String(err) });
      }
    };

    let proc;
    try {
      proc = spawn(input.cliPath, args, {
        cwd: input.cwd,
        shell: process.platform === 'win32', // resolve codex.cmd shim
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const message = `failed to spawn '${input.cliPath}': ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: 'error', message });
      resolve(fail(message, started));
      return;
    }

    try {
      proc.stdin.write(input.prompt);
      proc.stdin.end();
    } catch {
      /* surfaced via the no-result path below */
    }

    let sessionId: string | null = null;
    let finalText = '';
    let resultText: string | null = null;
    let usage: AgentUsage = emptyUsage();
    let turns = 0;
    let agentError: string | null = null;
    let stderr = '';
    let spawnError: string | null = null;
    let aborted = false;

    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', (e) => {
      spawnError = e.message;
    });

    const killTimer = setTimeout(() => {
      aborted = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, input.timeoutMs);

    const onAbort = () => {
      aborted = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: CodexLine;
      try {
        evt = JSON.parse(trimmed) as CodexLine;
      } catch {
        return; // ignore non-JSON noise
      }
      const msg: CodexMsg = evt.msg ?? (evt as CodexMsg);
      const type = msg.type ?? evt.type;

      // Session id can arrive on a session_configured event (nested or flat).
      const sid = msg.session_id ?? evt.session_id ?? evt.thread_id;
      if (sid && !sessionId) {
        sessionId = String(sid);
        emit({ type: 'init', sessionId, model: msg.model ?? input.model });
      }

      switch (type) {
        case 'agent_message': {
          const text = msg.message ?? msg.text;
          if (typeof text === 'string' && text) {
            turns++;
            finalText += text;
            emit({ type: 'text', text });
          }
          break;
        }
        case 'exec_command_begin': {
          emit({ type: 'tool_use', name: 'shell', input: msg.command ?? {} });
          break;
        }
        case 'exec_command_end': {
          const out = [msg.stdout, msg.stderr].filter(Boolean).join('\n');
          if (out) emit({ type: 'tool_result', text: out.slice(0, 2000) });
          break;
        }
        case 'token_count': {
          const counts = msg.info?.total_token_usage;
          if (counts) {
            usage = usageOf(counts, turns);
            emit({ type: 'usage', usage });
          }
          break;
        }
        case 'task_complete': {
          if (typeof msg.last_agent_message === 'string' && msg.last_agent_message) {
            resultText = msg.last_agent_message;
          }
          break;
        }
        case 'error':
        case 'stream_error': {
          agentError = msg.message ?? msg.text ?? 'agent reported error';
          emit({ type: 'error', message: agentError });
          break;
        }
        default:
          break; // ignore unknown event types
      }
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (input.signal) input.signal.removeEventListener('abort', onAbort);
      rl.close();

      usage = { ...usage, num_turns: usage.num_turns || turns };
      const text = resultText ?? finalText;

      if (aborted) {
        resolve({ ok: false, sessionId, text, usage, durationMs: Date.now() - started, error: 'aborted' });
        return;
      }

      if (agentError) {
        resolve({
          ok: false,
          sessionId,
          text,
          usage,
          durationMs: Date.now() - started,
          error: agentError,
          ...classifyAgentError(`${agentError}\n${stderr}`),
        });
        return;
      }

      if (code === 0 && (resultText !== null || finalText)) {
        resolve({ ok: true, sessionId, text, usage, durationMs: Date.now() - started });
        return;
      }

      const bits = [
        spawnError && `spawn error: ${spawnError}`,
        code !== 0 && `exit code ${code}`,
        stderr && `stderr: ${stderr.slice(0, 800)}`,
      ]
        .filter(Boolean)
        .join(' — ');
      const message = `codex exited without a result (${bits || 'no diagnostics'})`;
      emit({ type: 'error', message });
      resolve(fail(message, started, text, sessionId, classifyAgentError(`${message}\n${stderr}`)));
    });
  });

/**
 * Map Symphony's permission_mode to a Codex non-interactive sandbox/approval policy. The worktree
 * is already isolated, so the default (bypassPermissions) runs fully unsandboxed; other modes keep
 * Codex sandboxed to the workspace but still never block on an approval prompt.
 */
function sandboxArgs(mode: PermissionMode): string[] {
  if (mode === 'bypassPermissions') return ['--dangerously-bypass-approvals-and-sandbox'];
  // --full-auto = workspace-write sandbox with automatic, prompt-free execution.
  return ['--full-auto'];
}

function usageOf(counts: CodexUsageCounts, turns: number): AgentUsage {
  const input_tokens = counts.input_tokens ?? 0;
  const output_tokens = counts.output_tokens ?? 0;
  return {
    input_tokens,
    output_tokens,
    total_tokens: counts.total_tokens ?? input_tokens + output_tokens,
    num_turns: turns,
    cache_read_tokens: counts.cached_input_tokens ?? 0,
    cache_creation_tokens: 0,
  };
}

function emptyUsage(): AgentUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, num_turns: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function fail(
  error: string,
  started: number,
  text = '',
  sessionId: string | null = null,
  classified: { errorKind?: AgentErrorKind; retryAfterMs?: number } = {},
): AgentResult {
  return {
    ok: false,
    sessionId,
    text,
    usage: emptyUsage(),
    durationMs: Date.now() - started,
    error,
    ...classified,
  };
}
