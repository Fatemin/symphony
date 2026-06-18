import { exec } from 'node:child_process';
import path from 'node:path';
import type { VerificationCommandConfig, VerificationFailureAction } from '../core/projectConfig';
import { git } from './git';

export interface VerificationCommandResult {
  command: string;
  cwd: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  on_failure: VerificationFailureAction;
}

export interface VerificationResult {
  ok: boolean;
  commands: VerificationCommandResult[];
  failed?: VerificationCommandResult;
  action: VerificationFailureAction;
  summary: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export async function runVerificationCommands(
  worktreePath: string,
  commands: VerificationCommandConfig[],
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    const result = await runOne(worktreePath, command, signal);
    results.push(result);
    if (!result.ok) {
      return {
        ok: false,
        commands: results,
        failed: result,
        action: result.on_failure,
        summary: formatFailure(result),
      };
    }
  }
  const clean = await verifyCleanWorktree(worktreePath, commands.at(-1)?.on_failure ?? 'retry');
  if (!clean.ok) {
    results.push(clean);
    return {
      ok: false,
      commands: results,
      failed: clean,
      action: clean.on_failure,
      summary: formatFailure(clean),
    };
  }
  return {
    ok: true,
    commands: results,
    action: 'retry',
    summary: commands.length === 0 ? 'no verification commands configured' : `verification passed (${commands.length} command${commands.length === 1 ? '' : 's'})`,
  };
}

async function verifyCleanWorktree(
  worktreePath: string,
  onFailure: VerificationFailureAction,
): Promise<VerificationCommandResult> {
  const started = Date.now();
  const status = await git(['status', '--porcelain'], worktreePath);
  const stdout = status.ok ? status.stdout : '';
  const stderr = status.ok ? status.stderr : status.stderr || status.stdout;
  const dirty = status.ok && stdout.trim() !== '';
  return {
    command: 'git status --porcelain',
    cwd: path.resolve(worktreePath),
    ok: status.ok && !dirty,
    code: status.ok && dirty ? 1 : status.code,
    stdout: trimOutput(stdout),
    stderr: trimOutput(stderr),
    duration_ms: Date.now() - started,
    timed_out: false,
    on_failure: onFailure,
  };
}

function runOne(
  worktreePath: string,
  config: VerificationCommandConfig,
  signal?: AbortSignal,
): Promise<VerificationCommandResult> {
  const cwd = resolveCwd(worktreePath, config.cwd);
  const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    exec(
      config.command,
      {
        cwd,
        timeout,
        signal,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? null
            : 0;
        const timedOut = err ? /timed out|timeout/i.test(String((err as Error).message)) : false;
        resolve({
          command: config.command,
          cwd,
          ok: !err,
          code,
          stdout: trimOutput(String(stdout)),
          stderr: trimOutput(String(stderr)),
          duration_ms: Date.now() - started,
          timed_out: timedOut,
          on_failure: config.on_failure ?? 'retry',
        });
      },
    );
  });
}

function resolveCwd(worktreePath: string, cwd?: string): string {
  const resolved = cwd ? path.resolve(worktreePath, cwd) : path.resolve(worktreePath);
  assertInsideOrSame(worktreePath, resolved);
  return resolved;
}

function assertInsideOrSame(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`verification cwd escapes worktree: ${resolvedTarget} not under ${resolvedRoot}`);
  }
}

function trimOutput(output: string): string {
  if (output.length <= 12_000) return output;
  return `${output.slice(0, 6_000)}\n...[truncated]...\n${output.slice(-6_000)}`;
}

function formatFailure(result: VerificationCommandResult): string {
  const status = result.timed_out ? 'timed out' : `exited ${result.code ?? '?'}`;
  const parts = [`verification failed: ${result.command} (${status})`];
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
  return parts.join('\n\n');
}
