import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { log } from '../observability/logger';
import type { AgentEvent, AgentResult, AgentRunInput, AgentRunner } from './types';

// Raw shape of a Claude Code CLI `--output-format stream-json` line.
interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Real agent runner: spawns the Claude Code CLI headlessly and feeds the prompt over stdin as
 * stream-json (so prompt contents never pass through shell quoting). Parses the streamed events
 * into normalized AgentEvents and resolves with the final result. Conforms to `AgentRunner`.
 */
export const runClaudeCode: AgentRunner = (input: AgentRunInput, onEvent) =>
  new Promise<AgentResult>((resolve) => {
    const started = Date.now();
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', input.permissionMode,
      '--model', input.model,
    ];
    if (input.maxTurns > 0) args.push('--max-turns', String(input.maxTurns));
    if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);

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
        shell: process.platform === 'win32', // resolve claude.cmd shim
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const message = `failed to spawn '${input.cliPath}': ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: 'error', message });
      resolve(fail(message, started));
      return;
    }

    // Feed the prompt as a single stream-json user message, then close stdin.
    try {
      proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: input.prompt } }) + '\n',
      );
      proc.stdin.end();
    } catch {
      /* surfaced via the no-result path below */
    }

    let sessionId: string | null = null;
    let finalText = '';
    let resultLine: ClaudeLine | null = null;
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
      let evt: ClaudeLine;
      try {
        evt = JSON.parse(trimmed) as ClaudeLine;
      } catch {
        return; // ignore non-JSON noise
      }

      if (evt.type === 'system' && evt.subtype === 'init') {
        sessionId = evt.session_id ?? null;
        emit({ type: 'init', sessionId: sessionId ?? '', model: evt.model ?? input.model });
      } else if (evt.type === 'assistant' && evt.message?.content) {
        for (const item of evt.message.content) {
          if (item.type === 'text' && item.text) {
            finalText += item.text;
            emit({ type: 'text', text: item.text });
          } else if (item.type === 'tool_use' && item.name) {
            emit({ type: 'tool_use', name: item.name, input: item.input ?? {} });
          }
        }
      } else if (evt.type === 'user' && evt.message?.content) {
        for (const item of evt.message.content) {
          if (item.type === 'tool_result') {
            const c = item.content;
            const text =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c.map((x) => x.text ?? '').join('')
                  : JSON.stringify(c ?? '');
            emit({ type: 'tool_result', text: text.slice(0, 2000) });
          }
        }
      } else if (evt.type === 'result') {
        resultLine = evt;
        if (evt.session_id) sessionId = evt.session_id;
        emit({
          type: 'usage',
          usage: {
            input_tokens: evt.usage?.input_tokens ?? 0,
            output_tokens: evt.usage?.output_tokens ?? 0,
            total_tokens: (evt.usage?.input_tokens ?? 0) + (evt.usage?.output_tokens ?? 0),
            num_turns: evt.num_turns ?? 0,
          },
        });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (input.signal) input.signal.removeEventListener('abort', onAbort);
      rl.close();

      const r: ClaudeLine | null = resultLine;
      if (aborted) {
        resolve({
          ok: false,
          sessionId,
          text: finalText,
          usage: usageOf(r),
          durationMs: Date.now() - started,
          error: 'aborted',
        });
      } else if (r) {
        const isError = r.is_error === true;
        resolve({
          ok: !isError,
          sessionId,
          text: r.result ?? finalText,
          usage: usageOf(r),
          durationMs: r.duration_ms ?? Date.now() - started,
          error: isError ? (r.result ?? 'agent reported error') : undefined,
        });
      } else {
        const bits = [
          spawnError && `spawn error: ${spawnError}`,
          code !== 0 && `exit code ${code}`,
          stderr && `stderr: ${stderr.slice(0, 800)}`,
        ]
          .filter(Boolean)
          .join(' — ');
        const message = `claude exited without a result (${bits || 'no diagnostics'})`;
        emit({ type: 'error', message });
        resolve(fail(message, started, finalText, sessionId));
      }
    });
  });

function usageOf(r: ClaudeLine | null) {
  const input_tokens = r?.usage?.input_tokens ?? 0;
  const output_tokens = r?.usage?.output_tokens ?? 0;
  return { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, num_turns: r?.num_turns ?? 0 };
}

function fail(error: string, started: number, text = '', sessionId: string | null = null): AgentResult {
  return {
    ok: false,
    sessionId,
    text,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, num_turns: 0 },
    durationMs: Date.now() - started,
    error,
  };
}
