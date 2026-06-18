import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { log } from '../observability/logger';
import type { AgentErrorKind, AgentEvent, AgentResult, AgentRunInput, AgentRunner } from './types';

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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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
      // Pipeline sessions are unattended — interactive tools can never be answered. Blocking at
      // the CLI level (not just in the prompt) keeps a misbehaving agent from burning a turn.
      '--disallowedTools', 'AskUserQuestion',
    ];
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
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
        emit({ type: 'usage', usage: usageOf(evt) });
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
        const error = isError ? resultErrorMessage(r, input.maxTurns) : undefined;
        // A turn-cap death is never a quota error — and the synthetic message interpolates
        // maxTurns, which could otherwise false-match quota patterns (e.g. a cap of 429).
        const classified =
          error && r.subtype !== 'error_max_turns'
            ? classifyAgentError(`${error}\n${stderr}`)
            : {};
        resolve({
          ok: !isError,
          sessionId,
          text: r.result ?? finalText,
          usage: usageOf(r),
          durationMs: r.duration_ms ?? Date.now() - started,
          error,
          ...classified,
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
        resolve(fail(message, started, finalText, sessionId, classifyAgentError(message)));
      }
    });
  });

function usageOf(r: ClaudeLine | null) {
  const input_tokens = r?.usage?.input_tokens ?? 0;
  const output_tokens = r?.usage?.output_tokens ?? 0;
  return {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
    num_turns: r?.num_turns ?? 0,
    cache_read_tokens: r?.usage?.cache_read_input_tokens ?? 0,
    cache_creation_tokens: r?.usage?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Human-readable failure reason for an error result line. The CLI encodes WHY in `subtype`
 * (e.g. error_max_turns) and often leaves `result` empty — without this mapping every cap or
 * execution error surfaces as an opaque "agent reported error". Max-turns deaths matter most:
 * they are resumable, so the retry continues the session instead of restarting the phase.
 */
export function resultErrorMessage(
  r: { subtype?: string; result?: string },
  maxTurns: number,
): string {
  if (r.subtype === 'error_max_turns') {
    return `hit the ${maxTurns}-turn session cap before finishing — a retry resumes this session where it stopped`;
  }
  if (r.result?.trim()) return r.result;
  return r.subtype && r.subtype !== 'success'
    ? `agent reported error (${r.subtype})`
    : 'agent reported error';
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
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, num_turns: 0 },
    durationMs: Date.now() - started,
    error,
    ...classified,
  };
}

export function classifyAgentError(message: string): { errorKind?: AgentErrorKind; retryAfterMs?: number } {
  const lower = message.toLowerCase();
  const quota =
    lower.includes('session limit') ||
    lower.includes('usage limit') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('too many requests') ||
    /\b429\b/.test(lower);
  if (!quota) return {};
  return {
    errorKind: 'quota',
    retryAfterMs: parseRetryDelayMs(message) ?? 60 * 60_000,
  };
}

function parseRetryDelayMs(message: string): number | undefined {
  const relative = message.match(
    /(?:try again|retry|resets?)\s+(?:in\s+)?(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/i,
  );
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    if (Number.isFinite(n)) {
      if (unit.startsWith('second') || unit.startsWith('sec')) return n * 1000;
      if (unit.startsWith('minute') || unit.startsWith('min')) return n * 60_000;
      return n * 60 * 60_000;
    }
  }

  const clock = message.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;

  const now = new Date();
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset.getTime() - now.getTime();
}
