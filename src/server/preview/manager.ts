import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { log } from '../observability/logger';
import { appendEvent } from '../repo/events';

// Manages per-issue preview servers: launches the project's preview command FROM the issue's
// worktree (so the human can click through the running result at the review gate), one process
// per issue, on an allocated free port. Processes are tracked in-memory and torn down on stop,
// on approval (worktree removal), and on server shutdown.

export const DEFAULT_PREVIEW_COMMAND = 'npm run dev -- --port {port}';

interface PreviewProc {
  proc: ChildProcess;
  port: number;
  command: string;
  startedAt: number;
  output: string; // rolling tail of stdout+stderr (boot progress / errors)
}

const previews = new Map<string, PreviewProc>();

export interface PreviewStatus {
  running: boolean;
  url?: string;
  port?: number;
  command?: string;
  startedAt?: number;
  output?: string;
}

function statusOf(issueId: string): PreviewStatus {
  const p = previews.get(issueId);
  if (!p) return { running: false };
  return {
    running: true,
    url: `http://localhost:${p.port}`,
    port: p.port,
    command: p.command,
    startedAt: p.startedAt,
    output: p.output,
  };
}

export function getPreview(issueId: string): PreviewStatus {
  return statusOf(issueId);
}

/** Allocate a free localhost port by briefly binding port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startPreview(
  issueId: string,
  cwd: string,
  commandTemplate: string,
): Promise<PreviewStatus> {
  if (previews.has(issueId)) return statusOf(issueId); // already running

  const port = await freePort();
  const command = (commandTemplate || DEFAULT_PREVIEW_COMMAND).replace(/\{port\}/g, String(port));
  const proc = spawn(command, {
    cwd,
    shell: true, // run the command line as written (npm scripts, flags, &&, etc.)
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const entry: PreviewProc = { proc, port, command, startedAt: Date.now(), output: '' };
  const append = (b: Buffer) => {
    entry.output = (entry.output + b.toString()).slice(-4000);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  proc.on('exit', (code) => {
    // If the entry is already gone, stopPreview() removed it → intentional stop, stay quiet.
    // Otherwise the process died on its own (bad command, missing deps, crash) — surface it.
    const still = previews.get(issueId);
    if (!still) return;
    previews.delete(issueId);
    const tail = still.output.slice(-300).trim();
    log.warn('preview crashed', { issueId, code });
    appendEvent({
      issue_id: issueId,
      kind: 'preview.exited',
      level: 'warn',
      message: `preview exited (code ${code ?? '?'})${tail ? ` — ${tail}` : ''}`,
    });
  });

  previews.set(issueId, entry);
  log.info('preview started', { issueId, port, command });
  return statusOf(issueId);
}

export function stopPreview(issueId: string): boolean {
  const p = previews.get(issueId);
  if (!p) return false;
  previews.delete(issueId);
  killTree(p.proc);
  log.info('preview stopped', { issueId });
  return true;
}

export function stopAllPreviews(): void {
  for (const id of [...previews.keys()]) stopPreview(id);
}

/**
 * Kill the whole process tree. `shell: true` means proc is the shell (cmd.exe / sh); on Windows a
 * plain kill leaves the npm/node children alive, so use taskkill /T to take down the tree.
 */
function killTree(proc: ChildProcess): void {
  if (proc.pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3000);
  } catch {
    /* ignore */
  }
}
