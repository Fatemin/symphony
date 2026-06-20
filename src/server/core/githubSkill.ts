import { parse as parseYaml } from 'yaml';
import type { ProjectSkillFile } from '../../shared/types';

/**
 * Fetch a Claude Code skill (a SKILL.md) from GitHub (SYM-14). Accepts the common github.com link
 * shapes a user copies from the browser (blob/tree) plus raw.githubusercontent.com URLs, and
 * resolves them to the raw SKILL.md. A bare repo URL — github.com/<owner>/<repo>, no /blob//tree/ —
 * is also accepted (SYM-52): the default branch is resolved and the repo root then skills/ is probed
 * for a SKILL.md, so a flat single-skill repo imports without a deep link. The YAML front matter
 * (name + description) is parsed out so the skill can be stored + re-materialized with synthesized
 * front matter later.
 */
export interface FetchedSkill {
  name: string;
  description: string;
  content: string; // SKILL.md body with the front matter stripped
  source_url: string; // the original URL the user provided
  files?: ProjectSkillFile[];
}

/**
 * A GitHub skill URL resolved into its parts. `rawSkillUrl` is the raw SKILL.md the user's link
 * points at; `dir` is the repo-relative directory that CONTAINS that SKILL.md (used to list sibling
 * files); `isDirectory` is true when the URL did NOT already name a `.md` file — i.e. a /tree/ or
 * raw/blob folder link — which is the signal to fetch sibling files alongside SKILL.md (SYM-50).
 * `bareRepo` (SYM-52) marks a github.com/<owner>/<repo> URL with no ref: `rawSkillUrl`/`ref` are
 * empty because the default branch + skill directory are resolved later, in the async layer.
 */
export interface GithubSkillRef {
  rawSkillUrl: string;
  owner: string;
  repo: string;
  ref: string;
  dir: string;
  isDirectory: boolean;
  /** SYM-52: a bare repo URL whose ref/path are resolved in the network layer (default branch + root/skills probe). */
  bareRepo?: boolean;
}

/**
 * Resolve a GitHub URL into a {@link GithubSkillRef}:
 *   github.com/<o>/<r>/blob/<ref>/<path>           → raw.githubusercontent.com/<o>/<r>/<ref>/<path>
 *   github.com/<o>/<r>/tree/<ref>/<path/to/skill>  → …/<path/to/skill>/SKILL.md  (isDirectory)
 *   github.com/<o>/<r>                             → bareRepo ref (default branch + root/skills resolved later)
 *   raw.githubusercontent.com/<o>/<r>/<ref>/<path> → unchanged (SKILL.md appended if a directory)
 * Stays PURE/SYNC (no network) — the bare-repo default-branch lookup happens in fetchGithubSkill.
 * Throws on an unsupported host / shape.
 */
export function parseGithubSkillRef(url: string): GithubSkillRef {
  const trimmed = (url ?? '').trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  const host = u.hostname.toLowerCase();

  // `segs` are the encoded path segments [owner, repo, ref, ...path]; `rawUrlObj` is the
  // raw.githubusercontent.com URL the link maps to BEFORE the SKILL.md is ensured. Both host shapes
  // reduce to the same form so the ref fields are computed once below.
  let segs: string[];
  let rawUrlObj: URL;
  if (host === 'raw.githubusercontent.com') {
    segs = u.pathname.split('/').filter(Boolean);
    rawUrlObj = new URL(u.toString());
  } else if (host === 'github.com' || host === 'www.github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    const [owner, repo, kind, ref, ...rest] = parts;
    // SYM-52: a bare repo URL (github.com/<owner>/<repo>, no /blob//tree//raw/) resolves to a
    // directory ref whose default branch + skill dir are filled in by the async layer. Tolerates a
    // trailing slash (dropped by filter(Boolean) above) and a `.git` suffix on the repo.
    if (owner && repo && !kind) {
      return {
        rawSkillUrl: '',
        owner: decode(owner),
        repo: decode(stripGitSuffix(repo)),
        ref: '',
        dir: '',
        isDirectory: true,
        bareRepo: true,
      };
    }
    if (!owner || !repo || !ref || !kind || !['blob', 'tree', 'raw'].includes(kind)) {
      throw new Error(
        `unsupported GitHub URL: ${url} — expected a /blob/, /tree/ or /raw/ link to a skill, or a github.com/<owner>/<repo> repo URL`,
      );
    }
    segs = [owner, repo, ref, ...rest];
    rawUrlObj = new URL(
      `https://raw.githubusercontent.com/${segs.map(encodeURIComponent).join('/')}`,
    );
  } else {
    throw new Error(`unsupported host "${host}" — provide a github.com or raw.githubusercontent.com URL`);
  }

  const [owner, repo, ref, ...pathSegs] = segs;
  if (!owner || !repo || !ref) {
    throw new Error(`unsupported GitHub URL: ${url} — could not resolve owner/repo/ref`);
  }
  const lastSeg = pathSegs[pathSegs.length - 1] ?? '';
  const isDirectory = !/\.md$/i.test(lastSeg);
  // Directory link → the path IS the skill dir; an explicit *.md → its parent dir holds the siblings.
  const dirSegs = isDirectory ? pathSegs : pathSegs.slice(0, -1);
  return {
    rawSkillUrl: ensureSkillMd(rawUrlObj),
    owner: decode(owner),
    repo: decode(repo),
    ref: decode(ref),
    dir: dirSegs.map(decode).join('/'),
    isDirectory,
  };
}

/** Decode a single percent-encoded path segment, tolerating malformed sequences. */
function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Strip a trailing `.git` from a repo segment (a clone URL keeps it; the API path must not). */
function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/**
 * Normalize a GitHub URL to the raw SKILL.md it points at. Thin wrapper over
 * {@link parseGithubSkillRef} kept for callers that only need the resolved URL string.
 */
export function parseGithubSkillUrl(url: string): string {
  return parseGithubSkillRef(url).rawSkillUrl;
}

/** A directory link (or one missing a filename) maps to its SKILL.md; an explicit .md is honored. */
function ensureSkillMd(u: URL): string {
  if (/\.md$/i.test(u.pathname)) return u.toString();
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/SKILL.md`;
  return u.toString();
}

// Safety caps so a (malicious or merely huge) repo can't blow up an import. They are CONSTANTS, not
// settings: they guard the import path against pathological repos rather than being a user-tunable
// upload quota. fetchGithubSkill accepts an `opts` override so a test can inject tiny caps.
const MAX_SKILL_FILES = 50;
const MAX_SKILL_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MiB across all sibling files
const MAX_SKILL_DIR_DEPTH = 5;

export interface FetchSkillOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
}

/**
 * Sentinel for "the SKILL.md at this exact ref is a 404". Lets the bare-repo / marketplace fallbacks
 * distinguish "try the next candidate location" from a real network/rate-limit error they must surface
 * (SYM-52).
 */
export class SkillNotFoundError extends Error {
  constructor(rawUrl: string) {
    super(`SKILL.md not found at ${rawUrl}`);
    this.name = 'SkillNotFoundError';
  }
}

/**
 * Fetch + parse a skill. For a directory reference (a /tree/ or raw/blob folder link, or a bare-repo
 * root/skills probe) it also lists the skill directory via the GitHub contents API and pulls every
 * non-SKILL.md sibling file into `files` (relative paths preserved), so multi-file skills import
 * completely (SYM-50). An explicit `*.md` link stays single-file (`files` undefined). A bare repo URL
 * (SYM-52) first resolves the default branch, then probes the repo root and `skills/` for a SKILL.md.
 * Uses the Node global fetch — the sibling-fetch path is exercised offline via a stubbed fetch in
 * tests; the real network path is verified manually.
 */
export async function fetchGithubSkill(url: string, opts: FetchSkillOptions = {}): Promise<FetchedSkill> {
  const parsed = parseGithubSkillRef(url);
  if (parsed.bareRepo) {
    // Bare github.com/<owner>/<repo>: resolve the default branch (one extra API call) then probe the
    // repo root and skills/ for a flat single-skill layout (SYM-52).
    const branch = await fetchDefaultBranch(parsed.owner, parsed.repo);
    return fetchRepoLevelSkill(parsed.owner, parsed.repo, branch, url, opts);
  }
  // An explicit blob/tree/raw URL: a 404 here is the user's own link, surfaced as SkillNotFoundError.
  return fetchSkillAtRef(parsed, url, opts);
}

/**
 * Fetch + parse the SKILL.md named by `ref`, attaching sibling files for a directory ref. A 404 on
 * the raw SKILL.md throws {@link SkillNotFoundError} (so fallbacks can move to the next candidate);
 * network / other-non-ok failures keep the existing clear errors. `sourceUrl` is recorded verbatim as
 * the skill's `source_url` (the URL the user actually provided, not the resolved raw URL).
 */
async function fetchSkillAtRef(
  ref: GithubSkillRef,
  sourceUrl: string,
  opts: FetchSkillOptions,
): Promise<FetchedSkill> {
  let res: Response;
  try {
    res = await fetch(ref.rawSkillUrl, { headers: { 'user-agent': 'symphony', accept: 'text/plain' } });
  } catch (e) {
    throw new Error(`could not reach ${ref.rawSkillUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) throw new SkillNotFoundError(ref.rawSkillUrl);
  if (!res.ok) {
    throw new Error(`could not fetch skill from ${ref.rawSkillUrl}: ${res.status} ${res.statusText}`);
  }
  const raw = await res.text();
  const meta = parseFrontMatter(raw);
  const name =
    typeof meta?.name === 'string' && meta.name.trim()
      ? meta.name.trim()
      : deriveNameFromUrl(ref.rawSkillUrl);
  const description = typeof meta?.description === 'string' ? meta.description.trim() : '';
  const skill: FetchedSkill = {
    name,
    description,
    content: stripFrontMatter(raw).trim(),
    source_url: sourceUrl.trim(),
  };
  // Only fetch siblings AFTER SKILL.md 200s, so a non-skill directory fails fast (and marketplace's
  // per-skill try/catch keeps skipping it). An explicit *.md link is single-file by design.
  if (ref.isDirectory) {
    const files = await fetchSkillSiblings(ref, opts);
    if (files.length) skill.files = files;
  }
  return skill;
}

/** Resolve a repo's default branch via the GitHub API (one request; the bare-repo path only, SYM-52). */
async function fetchDefaultBranch(owner: string, repo: string): Promise<string> {
  const res = await ghFetch(`${API}/repos/${seg(owner)}/${seg(repo)}`, 'application/vnd.github+json');
  if (res.status === 404) throw new Error(`repository not found: ${owner}/${repo}`);
  assertNotRateLimited(res);
  if (!res.ok) {
    throw new Error(`could not resolve ${owner}/${repo}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { default_branch?: unknown };
  return typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main';
}

/** Build a directory {@link GithubSkillRef} for `<owner>/<repo>@<branch>/<dir>/SKILL.md` (SYM-52). */
function dirRefAt(owner: string, repo: string, branch: string, dir: string): GithubSkillRef {
  return {
    rawSkillUrl: `${RAW}/${seg(owner)}/${seg(repo)}/${seg(branch)}${dir ? `/${encodePath(dir)}` : ''}/SKILL.md`,
    owner,
    repo,
    ref: branch,
    dir,
    isDirectory: true,
  };
}

/**
 * Probe a bare repo for a flat single-skill layout: a SKILL.md at the repo root, else directly under
 * skills/ (SYM-52). A skills/<name>/ multi-skill layout is NOT handled here — that routes through the
 * marketplace resolver, which the error message points at.
 */
async function fetchRepoLevelSkill(
  owner: string,
  repo: string,
  branch: string,
  sourceUrl: string,
  opts: FetchSkillOptions,
): Promise<FetchedSkill> {
  for (const dir of ['', 'skills']) {
    try {
      return await fetchSkillAtRef(dirRefAt(owner, repo, branch, dir), sourceUrl, opts);
    } catch (e) {
      if (e instanceof SkillNotFoundError) continue; // try the next candidate location
      throw e; // a real network / rate-limit error must surface, not be swallowed
    }
  }
  throw new Error(
    `no SKILL.md found at the repo root or under skills/ in ${owner}/${repo}@${branch} — if this repo bundles multiple skills under skills/<name>/, use Install from Claude Code instead`,
  );
}

interface ContentEntry {
  type: string; // 'file' | 'dir' | 'symlink' | 'submodule'
  name: string;
  path: string; // repo-relative, decoded
  size?: number;
  download_url?: string | null;
}

/**
 * Recursively list `ref.dir` via the contents API and fetch each non-SKILL.md file. Relative paths
 * are computed against the skill root so nested files keep paths like `reference/x.md`. Enforces the
 * file-count / total-byte / depth caps (and a fan-out guard) BEFORE fetching each file, throwing on
 * exceed — an honest failure beats a silently-truncated, broken skill.
 */
async function fetchSkillSiblings(ref: GithubSkillRef, opts: FetchSkillOptions): Promise<ProjectSkillFile[]> {
  const maxFiles = opts.maxFiles ?? MAX_SKILL_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_SKILL_TOTAL_BYTES;
  const maxDepth = opts.maxDepth ?? MAX_SKILL_DIR_DEPTH;
  const maxEntries = Math.max(maxFiles, 1) * 20; // bound dir fan-out (entries scanned), generous vs. files

  const files: ProjectSkillFile[] = [];
  let totalBytes = 0;
  let scanned = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) throw new Error(`skill directory nesting exceeds ${maxDepth} levels`);
    const entries = await listDirEntries(ref, dir);
    scanned += entries.length;
    if (scanned > maxEntries) throw new Error(`skill directory has too many entries (> ${maxEntries})`);
    for (const entry of entries) {
      if (entry.type === 'dir') {
        await visit(entry.path, depth + 1);
        continue;
      }
      if (entry.type !== 'file' || !entry.download_url) continue; // skip symlink/submodule/unfetchable
      const rel = ref.dir ? entry.path.slice(ref.dir.length + 1) : entry.path;
      if (rel.toLowerCase() === 'skill.md') continue; // the top-level SKILL.md is already `content`
      if (files.length >= maxFiles) throw new Error(`skill has more than ${maxFiles} files`);
      totalBytes += entry.size ?? 0;
      if (totalBytes > maxTotalBytes) throw new Error(`skill files exceed ${maxTotalBytes} bytes`);
      files.push({ path: rel, content: await fetchText(entry.download_url) });
    }
  };
  await visit(ref.dir, 0);
  return files;
}

/** Contents-API listing of one directory inside the skill's repo (404 → the dir is gone). */
async function listDirEntries(ref: GithubSkillRef, dir: string): Promise<ContentEntry[]> {
  // dir='' (a bare-repo root probe) maps to `/contents?ref=…` with no trailing slash (SYM-52).
  const url = `${API}/repos/${seg(ref.owner)}/${seg(ref.repo)}/contents${dir ? `/${encodePath(dir)}` : ''}?ref=${seg(ref.ref)}`;
  const res = await ghFetch(url, 'application/vnd.github+json');
  if (res.status === 404) {
    throw new Error(`skill directory not found: ${dir} in ${ref.owner}/${ref.repo}@${ref.ref}`);
  }
  assertNotRateLimited(res);
  if (!res.ok) {
    throw new Error(`could not list ${dir} in ${ref.owner}/${ref.repo}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) return [];
  return body.filter(isContentEntry);
}

function isContentEntry(e: unknown): e is ContentEntry {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as { type?: unknown }).type === 'string' &&
    typeof (e as { name?: unknown }).name === 'string' &&
    typeof (e as { path?: unknown }).path === 'string'
  );
}

/** Fetch a sibling file's bytes as UTF-8 text (binary assets aren't supported — the byte cap bounds size). */
async function fetchText(downloadUrl: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(downloadUrl, { headers: { 'user-agent': 'symphony', accept: 'text/plain' } });
  } catch (e) {
    throw new Error(`could not reach ${downloadUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`could not fetch skill file from ${downloadUrl}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Parse the leading `---` YAML front matter into an object (null when absent/malformed). */
export function parseFrontMatter(raw: string): Record<string, unknown> | null {
  const fm = extractFrontMatter(raw);
  if (!fm) return null;
  try {
    const doc = parseYaml(fm);
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pull the YAML between a leading `---` fence and the next `---` (mirrors core/workflow.ts). */
export function extractFrontMatter(raw: string): string | null {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(3, end).trim();
}

/** Return the document body with any leading `---` front-matter block removed. */
export function stripFrontMatter(raw: string): string {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const closeLineEnd = text.indexOf('\n', end + 1); // skip past the closing `---` line
  return closeLineEnd === -1 ? '' : text.slice(closeLineEnd + 1);
}

/** A SKILL.md's skill name is its parent directory; for a bare `foo.md` use the filename stem. */
function deriveNameFromUrl(rawUrl: string): string {
  const parts = new URL(rawUrl).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const file = parts[parts.length - 1] ?? 'skill';
  if (/^SKILL\.md$/i.test(file)) return parts[parts.length - 2] ?? 'skill';
  return file.replace(/\.md$/i, '') || 'skill';
}

// ── shared GitHub HTTP plumbing (also imported by marketplaceSkill.ts) ────────
// One source of truth for the contents-API host + auth + path encoding so the skill importer and the
// marketplace resolver behave identically (SYM-50).

export const API = 'https://api.github.com';

/** raw.githubusercontent.com host for building raw SKILL.md URLs (shared with marketplaceSkill.ts). */
export const RAW = 'https://raw.githubusercontent.com';

/** A path segment encoder for owner/repo/ref values. */
export const seg = (s: string): string => encodeURIComponent(s);

/** Encode a slash-separated repo path one segment at a time (drops empty segments). */
export const encodePath = (p: string): string =>
  p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** Fetch with the GitHub auth/UA headers, wrapping network errors in a clear message. */
export async function ghFetch(url: string, accept: string): Promise<Response> {
  try {
    return await fetch(url, { headers: ghHeaders(accept) });
  } catch (e) {
    throw new Error(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Headers for a GitHub API/raw request; a GITHUB_TOKEN raises the ~60/hr unauthenticated limit. */
export function ghHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': 'symphony', accept };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Throw the rate-limit hint when GitHub answers 403 with the unauthenticated quota exhausted. */
export function assertNotRateLimited(res: Response): void {
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error(
      'GitHub API rate limit reached — set GITHUB_TOKEN to raise the ~60 requests/hour unauthenticated limit',
    );
  }
}
