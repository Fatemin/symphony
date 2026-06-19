import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentType, AgentUsage, AgentUsageReport, UsageStatus } from '../../shared/types';

/**
 * SYM-38: read the LOCAL Claude Code / Codex CLI session logs and aggregate today's token usage
 * for the sidebar footer widget. Read-only and self-contained — it touches nothing Symphony owns,
 * only the CLIs' own data dirs, and writes nothing (so the repo's .gitignore needs no new rule).
 *
 * Design points (verified against live CLI logs + ccusage's reader):
 *  - "today" is the SERVER's local-machine day boundary — Symphony runs locally beside the CLIs, so
 *    their session timestamps share its clock. We report token *usage*, not a billing/cost figure.
 *  - Each agent root is scanned inside its OWN try/catch (`buildReport`) so a missing/locked Claude
 *    dir never blanks the Codex row and vice-versa — the endpoint always returns per-agent statuses.
 *  - Env overrides are read at CALL time (not import time) so tests can point CLAUDE_CONFIG_DIR /
 *    CODEX_HOME at throwaway dirs. Files are streamed line-by-line (they grow to multi-MB), and a
 *    file whose mtime predates today is skipped before any read.
 */

function emptyUsage(): AgentUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
  };
}

/** Read both agents independently and return one report row each. */
export async function readLocalUsage(): Promise<AgentUsageReport[]> {
  const now = new Date(); // a single day boundary for the whole request (avoids a midnight race)
  const [claude, codex] = await Promise.all([readClaudeUsage(now), readCodexUsage(now)]);
  return [claude, codex];
}

// ── Per-agent readers ──────────────────────────────────────────────────────

function readClaudeUsage(now: Date): Promise<AgentUsageReport> {
  return buildReport('claude', () => scanClaude(now));
}

function readCodexUsage(now: Date): Promise<AgentUsageReport> {
  return buildReport('codex', () => scanCodex(now));
}

interface ScanResult {
  /** Did at least one of the agent's data roots exist? (false ⇒ not installed / never run.) */
  anyRootFound: boolean;
  usage: AgentUsage;
}

/**
 * Wrap a scan with the status classification + the per-agent isolation boundary. `not_found` when no
 * root exists, `ok`/`empty` by whether today logged any tokens, `error` (with a reason) on any throw.
 */
async function buildReport(agent: AgentType, scan: () => Promise<ScanResult>): Promise<AgentUsageReport> {
  try {
    const { anyRootFound, usage } = await scan();
    if (!anyRootFound) return { agent, status: 'not_found', usage: emptyUsage() };
    const status: UsageStatus = usage.total_tokens > 0 ? 'ok' : 'empty';
    return { agent, status, usage };
  } catch (err) {
    return { agent, status: 'error', usage: emptyUsage(), error: errMessage(err) };
  }
}

/**
 * Claude Code: sessions live at `<root>/projects/**\/*.jsonl`. Only `type:'assistant'` lines carry
 * `message.usage`; each assistant message is flushed to disk 2–4× identically, so we dedup by
 * `${message.id}:${requestId}` before summing. Root = CLAUDE_CONFIG_DIR (may be comma-separated)
 * else both ~/.claude and ~/.config/claude.
 */
async function scanClaude(now: Date): Promise<ScanResult> {
  const usage = emptyUsage();
  const seen = new Set<string>();
  let anyRootFound = false;

  for (const root of claudeRoots()) {
    if (!directoryExists(root)) continue;
    anyRootFound = true;
    const files = collectJsonlFiles(path.join(root, 'projects'), (name) => name.endsWith('.jsonl'));
    for (const file of files) {
      if (!modifiedToday(file, now)) continue;
      await readJsonlLines(file, (obj) => addClaudeLine(obj, now, seen, usage));
    }
  }

  finalizeTotal(usage);
  return { anyRootFound, usage };
}

function addClaudeLine(obj: unknown, now: Date, seen: Set<string>, usage: AgentUsage): void {
  const line = obj as ClaudeLine;
  if (!line || line.type !== 'assistant') return;
  const u = line.message?.usage;
  if (!u) return;
  const ts = parseTs(line.timestamp);
  if (ts === null || !isSameLocalDay(ts, now)) return;

  // Dedup the repeated flushes of one message. Only dedup when an id is present so two distinct
  // id-less lines (rare) are never collapsed into one.
  const id = line.message?.id;
  if (id) {
    const key = `${id}:${line.requestId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
  }

  usage.input_tokens += num(u.input_tokens);
  usage.output_tokens += num(u.output_tokens);
  usage.cache_read_tokens += num(u.cache_read_input_tokens);
  usage.cache_creation_tokens += num(u.cache_creation_input_tokens);
}

/**
 * Codex: rollouts live at `<root>/{sessions,archived_sessions}/**\/rollout-*.jsonl`. Token usage is
 * on `event_msg` lines with `payload.type:'token_count'`; sum the PER-TURN delta
 * `payload.info.last_token_usage` (NOT `total_token_usage`, which is cumulative and double-counts).
 * Root = CODEX_HOME else ~/.codex.
 */
async function scanCodex(now: Date): Promise<ScanResult> {
  const usage = emptyUsage();
  let anyRootFound = false;

  for (const root of codexRoots()) {
    if (!directoryExists(root)) continue;
    anyRootFound = true;
    const files = [
      ...collectJsonlFiles(path.join(root, 'sessions'), isRolloutFile),
      ...collectJsonlFiles(path.join(root, 'archived_sessions'), isRolloutFile),
    ];
    for (const file of files) {
      if (!modifiedToday(file, now)) continue;
      await readJsonlLines(file, (obj) => addCodexLine(obj, now, usage));
    }
  }

  finalizeTotal(usage);
  return { anyRootFound, usage };
}

function addCodexLine(obj: unknown, now: Date, usage: AgentUsage): void {
  const line = obj as CodexLine;
  const payload = line?.payload;
  if (!payload || payload.type !== 'token_count') return;
  const last = payload.info?.last_token_usage;
  if (!last) return;
  const ts = parseTs(line.timestamp);
  if (ts === null || !isSameLocalDay(ts, now)) return;

  usage.input_tokens += num(last.input_tokens);
  usage.cache_read_tokens += num(last.cached_input_tokens);
  // Reasoning tokens are billed as output; fold them in so the breakdown stays meaningful.
  usage.output_tokens += num(last.output_tokens) + num(last.reasoning_output_tokens);
  // Codex reports no cache-creation figure — leave cache_creation_tokens at 0.
}

const isRolloutFile = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl');

// ── Roots (env read at call time) ───────────────────────────────────────────

function claudeRoots(): string[] {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (override) {
    return override
      .split(',')
      .map((p) => expandHome(p.trim()))
      .filter(Boolean);
  }
  return [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.config', 'claude')];
}

function codexRoots(): string[] {
  const override = process.env.CODEX_HOME?.trim();
  if (override) return [expandHome(override)];
  return [path.join(os.homedir(), '.codex')];
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

// ── Filesystem helpers ──────────────────────────────────────────────────────

/** True if `p` exists and is a directory. ENOENT ⇒ false; any other error (e.g. EACCES) bubbles. */
function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Recursively collect files under `dir` whose basename passes `match`. A missing directory is
 * benign (returns nothing); any other read error (EACCES …) bubbles up to mark the agent `error`.
 */
function collectJsonlFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  walk(dir);
  return out;

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && match(entry.name)) out.push(full);
    }
  }
}

/** Skip files not modified today — they cannot contain today's usage. */
function modifiedToday(file: string, now: Date): boolean {
  try {
    return isSameLocalDay(fs.statSync(file).mtimeMs, now);
  } catch {
    return false; // vanished between listing and stat → skip
  }
}

/** Stream one JSONL file, parsing each line. A truncated final line on a live file is normal → skip. */
function readJsonlLines(file: string, onObj: (obj: unknown) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    stream.on('error', reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      onObj(obj);
    });
    rl.on('close', resolve);
  });
}

// ── Small utilities ─────────────────────────────────────────────────────────

function finalizeTotal(usage: AgentUsage): void {
  usage.total_tokens =
    usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
}

function isSameLocalDay(ts: number, now: Date): boolean {
  const d = new Date(ts);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function parseTs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Raw line shapes (private to this reader) ─────────────────────────────────

interface ClaudeLine {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface CodexLine {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
  };
}
