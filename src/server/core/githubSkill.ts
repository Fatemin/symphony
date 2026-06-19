import { parse as parseYaml } from 'yaml';
import type { ProjectSkillFile } from '../../shared/types';

/**
 * Fetch a Claude Code skill (a SKILL.md) from GitHub (SYM-14). Accepts the common github.com link
 * shapes a user copies from the browser (blob/tree) plus raw.githubusercontent.com URLs, and
 * resolves them to the raw SKILL.md. The YAML front matter (name + description) is parsed out so
 * the skill can be stored + re-materialized with synthesized front matter later.
 */
export interface FetchedSkill {
  name: string;
  description: string;
  content: string; // SKILL.md body with the front matter stripped
  source_url: string; // the original URL the user provided
  files?: ProjectSkillFile[];
}

/**
 * Normalize a GitHub URL to the raw SKILL.md it points at:
 *   github.com/<o>/<r>/blob/<ref>/<path>           → raw.githubusercontent.com/<o>/<r>/<ref>/<path>
 *   github.com/<o>/<r>/tree/<ref>/<path/to/skill>  → …/<path/to/skill>/SKILL.md
 *   raw.githubusercontent.com/<o>/<r>/<ref>/<path> → unchanged (SKILL.md appended if a directory)
 * Throws on an unsupported host / shape.
 */
export function parseGithubSkillUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  const host = u.hostname.toLowerCase();

  if (host === 'raw.githubusercontent.com') {
    return ensureSkillMd(u);
  }
  if (host === 'github.com' || host === 'www.github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    const [owner, repo, kind, ref, ...rest] = parts;
    if (!owner || !repo || !ref || !kind || !['blob', 'tree', 'raw'].includes(kind)) {
      throw new Error(
        `unsupported GitHub URL: ${url} — expected a /blob/, /tree/ or /raw/ link to a skill`,
      );
    }
    const raw = new URL(
      `https://raw.githubusercontent.com/${[owner, repo, ref, ...rest].map(encodeURIComponent).join('/')}`,
    );
    return ensureSkillMd(raw);
  }
  throw new Error(`unsupported host "${host}" — provide a github.com or raw.githubusercontent.com URL`);
}

/** A directory link (or one missing a filename) maps to its SKILL.md; an explicit .md is honored. */
function ensureSkillMd(u: URL): string {
  if (/\.md$/i.test(u.pathname)) return u.toString();
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/SKILL.md`;
  return u.toString();
}

/** Fetch + parse a skill. Uses the Node global fetch (NOT exercised by the offline test suite). */
export async function fetchGithubSkill(url: string): Promise<FetchedSkill> {
  const rawUrl = parseGithubSkillUrl(url);
  let res: Response;
  try {
    res = await fetch(rawUrl, { headers: { 'user-agent': 'symphony', accept: 'text/plain' } });
  } catch (e) {
    throw new Error(`could not reach ${rawUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`could not fetch skill from ${rawUrl}: ${res.status} ${res.statusText}`);
  }
  const raw = await res.text();
  const meta = parseFrontMatter(raw);
  const name =
    typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : deriveNameFromUrl(rawUrl);
  const description = typeof meta?.description === 'string' ? meta.description.trim() : '';
  return { name, description, content: stripFrontMatter(raw).trim(), source_url: url.trim() };
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
