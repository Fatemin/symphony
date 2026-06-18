import { Hono } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Local filesystem browser for picking a project's `repo_path`.
 *
 * A browser folder picker can't return an absolute path (security), but this is
 * a localhost single-user tool whose server runs on the same machine — so the
 * server lists directories and the client navigates to an absolute path. It
 * exposes only directory *names* (never file contents), consistent with a tool
 * that already runs agents on the local machine.
 */
export const fsRoutes = new Hono();

/** Resolve `~`, env-relative, and relative input to an absolute path. */
function expand(input: string | undefined): string {
  const s = (input ?? '').trim();
  if (!s) return homedir();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return resolve(join(homedir(), s.slice(2)));
  return resolve(s);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

// GET /api/fs/browse?path=...  → subdirectories of `path` for the picker.
// Falls back to the home directory when `path` is missing or not a directory,
// so the picker always opens somewhere valid.
fsRoutes.get('/browse', (c) => {
  let path = expand(c.req.query('path'));
  if (!isDir(path)) path = homedir();

  let entries: Array<{ name: string; path: string; isGitRepo: boolean }> = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')) // hide dotdirs (.git, caches, …)
      .map((d) => {
        const child = join(path, d.name);
        return { name: d.name, path: child, isGitRepo: isGitRepo(child) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (e) {
    return c.json({ error: `Cannot read directory: ${e instanceof Error ? e.message : String(e)}` }, 400);
  }

  const parent = dirname(path);
  return c.json({
    path,
    parent: parent === path ? null : parent, // null at the filesystem root
    isGitRepo: isGitRepo(path),
    entries,
  });
});

// GET /api/fs/validate?path=...  → check a typed/selected path. Always 200; the
// payload's `ok`/`error`/`warning` describe the result (a missing repo is a
// warning, not an error — such projects sit on the board but can't run agents).
fsRoutes.get('/validate', (c) => {
  const raw = c.req.query('path') ?? '';
  if (!raw.trim()) return c.json({ ok: false, error: 'Path is empty' });
  const path = expand(raw);

  let st;
  try {
    st = statSync(path);
  } catch {
    return c.json({ ok: false, resolved: path, exists: false, error: 'Path does not exist' });
  }
  if (!st.isDirectory()) {
    return c.json({ ok: false, resolved: path, exists: true, isDirectory: false, error: 'Path is not a directory' });
  }

  const git = isGitRepo(path);
  return c.json({
    ok: true,
    resolved: path,
    exists: true,
    isDirectory: true,
    isGitRepo: git,
    warning: git ? undefined : 'Not a git repository — agent execution needs one (you can still create the project)',
  });
});
