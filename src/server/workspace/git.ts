import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a git command, capturing output. Never throws — inspect `ok`/`code`. */
export function git(args: string[], cwd?: string, timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0;
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

/** Run git and throw a descriptive error on failure. */
export async function gitOrThrow(args: string[], cwd?: string): Promise<string> {
  const r = await git(args, cwd);
  if (!r.ok) {
    throw new Error(`git ${args.join(' ')} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir);
  return r.ok && r.stdout.trim() === 'true';
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo);
  return r.ok;
}

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  return r.ok ? r.stdout.trim() || null : null;
}
