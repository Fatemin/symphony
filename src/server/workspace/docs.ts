import fs from 'node:fs';
import path from 'node:path';
import type { DocContent, DocEntry, DocListing } from '../../shared/types';

/**
 * SYM-36: read a project's on-disk documentation for the Documentation tab. Read-only and
 * untrusted-input safe — the repo lives on the same machine but the requested path comes from the
 * browser, so every read is fenced inside the project's repo AND inside a configured doc directory.
 *
 * Two safety layers, mirroring the worktree sandbox invariant (§9.5):
 *  - lexical: reject absolute paths and any '..' segment before touching disk;
 *  - physical: resolve realpath (following symlinks) and re-assert it stays inside the repo, so a
 *    symlink inside a doc dir can't smuggle in a file from elsewhere on disk.
 * Listing skips symlinks entirely (Dirent.isFile/isDirectory are false for them).
 */

// Text/markdown formats we render. Markdown gets the themed renderer; the rest show as plain text.
const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.json',
  '.yml',
  '.yaml',
]);

const MAX_FILE_BYTES = 1_000_000; // ~1MB — docs are prose, not data dumps
const MAX_DEPTH = 8; // guard against pathological deep trees
const MAX_FILES = 500; // bound the listing so a huge tree can't stall the response
const SKIP_DIRS = new Set(['node_modules']); // dotdirs (.git, …) are skipped by the dotfile rule

export type ReadDocResult =
  | { ok: true; doc: DocContent }
  | { ok: false; status: 400 | 404; error: string };

/** Walk the configured directories of a repo and list the allow-listed doc files within them. */
export function listProjectDocs(repoPath: string, directories: string[]): DocListing {
  const files: DocEntry[] = [];
  const root = safeRealpath(repoPath);
  if (!root) return { directories, files };

  const seen = new Set<string>();
  for (const dir of directories) {
    if (files.length >= MAX_FILES) break;
    const base = path.resolve(root, dir);
    // A configured directory that escapes the repo, doesn't exist, or isn't a directory is simply
    // skipped — one bad entry must not break the whole listing.
    if (!isInsideOrEqual(root, base)) continue;
    let stat;
    try {
      stat = fs.statSync(base);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    walk(base, dir, 0, root, files, seen);
  }

  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return { directories, files };
}

function walk(
  absDir: string,
  configuredDir: string,
  depth: number,
  root: string,
  files: DocEntry[],
  seen: Set<string>,
): void {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith('.')) continue; // dotfiles/dotdirs (.git, .DS_Store, …)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(absDir, entry.name), configuredDir, depth + 1, root, files, seen);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      const rel = toPosix(path.relative(root, path.join(absDir, entry.name)));
      if (seen.has(rel)) continue;
      seen.add(rel);
      files.push({ path: rel, name: entry.name, dir: configuredDir });
    }
  }
}

/** Read one doc by its repo-relative path, validating it sits inside a configured doc directory. */
export function readProjectDoc(
  repoPath: string,
  directories: string[],
  relPath: string,
): ReadDocResult {
  const root = safeRealpath(repoPath);
  if (!root) return { ok: false, status: 404, error: 'repo not found' };

  const requested = (relPath ?? '').trim();
  if (!requested) return { ok: false, status: 400, error: 'path is required' };
  // Lexical guard: never trust the client path.
  if (path.isAbsolute(requested) || hasDotDotSegment(requested)) {
    return { ok: false, status: 400, error: 'invalid path' };
  }

  const ext = path.extname(requested).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, status: 400, error: 'unsupported file type' };
  }

  // Defence in depth: a path can be inside the repo yet outside every doc root — reject it.
  if (!directories.some((dir) => isWithinConfiguredDir(dir, requested))) {
    return { ok: false, status: 400, error: 'path is outside the configured doc directories' };
  }

  const target = path.resolve(root, requested);
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return { ok: false, status: 404, error: 'document not found' };
  }
  // Physical guard: the symlink-resolved path must still live inside the repo.
  if (!isInside(root, real)) return { ok: false, status: 400, error: 'invalid path' };

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, status: 404, error: 'document not found' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: 'document not found' };
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, status: 400, error: 'document is too large to display' };
  }

  const content = fs.readFileSync(real, 'utf8');
  return { ok: true, doc: { path: toPosix(path.relative(root, real)), name: path.basename(real), content } };
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function hasDotDotSegment(p: string): boolean {
  return p.split(/[/\\]+/).some((seg) => seg === '..');
}

/** Strictly inside `root` (excludes `root` itself). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Inside `root` or equal to it. */
function isInsideOrEqual(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isWithinConfiguredDir(dir: string, requested: string): boolean {
  const d = toPosix(dir).replace(/^\/+|\/+$/g, '');
  const r = toPosix(requested).replace(/^\/+/, '');
  if (!d) return false;
  return r === d || r.startsWith(`${d}/`);
}
