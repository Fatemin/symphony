import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type {
  AgentType,
  AgentUsage,
  AgentUsageReport,
  RateWindow,
  UsageStatus,
} from '../../shared/types';

/**
 * SYM-38 / SYM-39: read the LOCAL Claude Code / Codex CLI session logs for the sidebar footer widget.
 * SYM-39 repurposed the widget from token *usage* to **remaining** rate-limit quota (the user wants to
 * see what's left, not what's spent). Read-only and self-contained — it touches nothing Symphony owns,
 * only the CLIs' own data dirs, and writes nothing (so the repo's .gitignore needs no new rule).
 *
 * Design points (verified against live CLI logs):
 *  - Codex logs its live rate limits: each `token_count` event carries `payload.rate_limits` with a
 *    `primary` (short rolling) and `secondary` (weekly) window, each `{ used_percent, window_minutes,
 *    resets_at }`. We take the LATEST snapshot (max timestamp, any day) and report remaining = 100 −
 *    used. Claude exposes NO local quota state — its assistant lines carry only usage, and
 *    `~/.claude.json` holds only the plan tier — so Claude's row is `unsupported`.
 *  - Today's token totals are still computed for the tooltip on both agents. "today" is the SERVER's
 *    local-machine day boundary — Symphony runs locally beside the CLIs, so timestamps share its clock.
 *  - Each agent root is scanned inside its OWN try/catch (`buildReport`) so a missing/locked Claude
 *    dir never blanks the Codex row and vice-versa — the endpoint always returns per-agent statuses.
 *  - Env overrides are read at CALL time (not import time) so tests can point CLAUDE_CONFIG_DIR /
 *    CODEX_HOME at throwaway dirs. Files are streamed line-by-line (they grow to multi-MB). Claude
 *    files are bounded to today's mtime; Codex files to ~8 days so the weekly snapshot stays visible.
 */

/**
 * Codex's weekly window is 7 days; scan rollouts touched within ~8 days so the latest snapshot of that
 * window is always in range. Today's-usage summation still filters per-line by local day, so widening
 * the file set adds rate-limit visibility WITHOUT changing usage numbers.
 */
const CODEX_RATE_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

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
  // Claude has NO local remaining-quota data, so once its dir is found the row is `unsupported`. Today's
  // usage is still computed so the tooltip can show today's tokens (see scanClaude).
  return buildReport('claude', () => scanClaude(now), () => ({ status: 'unsupported' }));
}

function readCodexUsage(now: Date): Promise<AgentUsageReport> {
  // Codex is `ok` when a rate-limit snapshot yielded remaining windows, else `empty` (dir present, no
  // snapshot within the lookback). Windows ride along on the `ok` row.
  return buildReport('codex', () => scanCodex(now), (r) =>
    r.windows && r.windows.length > 0 ? { status: 'ok', windows: r.windows } : { status: 'empty' },
  );
}

interface ScanResult {
  /** Did at least one of the agent's data roots exist? (false ⇒ not installed / never run.) */
  anyRootFound: boolean;
  usage: AgentUsage;
  /** Codex remaining windows from the latest rate-limit snapshot; undefined for Claude / when none. */
  windows?: RateWindow[];
}

/** The agent-specific verdict for a scanned, existing root (not_found/error are handled by buildReport). */
interface Classification {
  status: UsageStatus;
  windows?: RateWindow[];
}

/**
 * Wrap a scan with the per-agent status classification + the isolation boundary. `not_found` when no
 * root exists; otherwise the agent's `classify` decides `ok`/`empty`/`unsupported` (and any windows);
 * `error` (with a reason) on any throw. `usage` is always returned for the tooltip.
 */
async function buildReport(
  agent: AgentType,
  scan: () => Promise<ScanResult>,
  classify: (result: ScanResult) => Classification,
): Promise<AgentUsageReport> {
  try {
    const result = await scan();
    if (!result.anyRootFound) return { agent, status: 'not_found', usage: emptyUsage() };
    const { status, windows } = classify(result);
    return { agent, status, usage: result.usage, ...(windows && windows.length > 0 ? { windows } : {}) };
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
 * Codex: rollouts live at `<root>/{sessions,archived_sessions}/**\/rollout-*.jsonl`. Each `event_msg`
 * line with `payload.type:'token_count'` carries BOTH today's per-turn usage (`payload.info`) and a
 * live `payload.rate_limits` snapshot. We collect two things in one pass (see `addCodexLine`):
 *  - today's tokens — sum the PER-TURN delta `last_token_usage` (NOT cumulative `total_token_usage`),
 *    filtered per-line to the local day; and
 *  - the LATEST rate-limit snapshot (max timestamp, any day) → remaining windows.
 * Root = CODEX_HOME else ~/.codex.
 */
async function scanCodex(now: Date): Promise<ScanResult> {
  const state: CodexScanState = { usage: emptyUsage(), latest: null };
  let anyRootFound = false;
  const nowMs = now.getTime();

  for (const root of codexRoots()) {
    if (!directoryExists(root)) continue;
    anyRootFound = true;
    const files = [
      ...collectJsonlFiles(path.join(root, 'sessions'), isRolloutFile),
      ...collectJsonlFiles(path.join(root, 'archived_sessions'), isRolloutFile),
    ];
    for (const file of files) {
      // Wider than Claude's today-only window so the weekly rate-limit snapshot stays in range.
      if (!modifiedWithin(file, nowMs, CODEX_RATE_LOOKBACK_MS)) continue;
      await readJsonlLines(file, (obj) => addCodexLine(obj, now, state));
    }
  }

  finalizeTotal(state.usage);
  const windows = state.latest ? buildCodexWindows(state.latest.rateLimits, nowMs) : [];
  return { anyRootFound, usage: state.usage, windows };
}

interface CodexScanState {
  usage: AgentUsage;
  /** The token_count snapshot with the greatest timestamp that carried rate_limits (any day). */
  latest: { ts: number; rateLimits: RawRateLimits } | null;
}

function addCodexLine(obj: unknown, now: Date, state: CodexScanState): void {
  const line = obj as CodexLine;
  const payload = line?.payload;
  if (!payload || payload.type !== 'token_count') return;
  const ts = parseTs(line.timestamp);
  if (ts === null) return;

  // (a) Today's usage — only same-local-day turns contribute to the tooltip totals.
  const last = payload.info?.last_token_usage;
  if (last && isSameLocalDay(ts, now)) {
    state.usage.input_tokens += num(last.input_tokens);
    state.usage.cache_read_tokens += num(last.cached_input_tokens);
    // Reasoning tokens are billed as output; fold them in so the breakdown stays meaningful.
    state.usage.output_tokens += num(last.output_tokens) + num(last.reasoning_output_tokens);
    // Codex reports no cache-creation figure — leave cache_creation_tokens at 0.
  }

  // (b) Remaining quota — keep the latest snapshot by timestamp, regardless of day.
  const rl = payload.rate_limits;
  if (rl && (state.latest === null || ts > state.latest.ts)) {
    state.latest = { ts, rateLimits: rl };
  }
}

/** Build the remaining windows from a raw rate_limits snapshot, applying staleness roll-over. */
function buildCodexWindows(rl: RawRateLimits, nowMs: number): RateWindow[] {
  const out: RateWindow[] = [];
  const primary = buildWindow('primary', rl.primary, nowMs);
  if (primary) out.push(primary);
  const secondary = buildWindow('secondary', rl.secondary, nowMs);
  if (secondary) out.push(secondary);
  return out;
}

function buildWindow(key: 'primary' | 'secondary', raw: RawWindow | undefined, nowMs: number): RateWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const windowMinutes = Math.max(0, Math.round(toNum(raw.window_minutes)));
  const windowMs = windowMinutes * 60_000;
  let resetsAtMs = toNum(raw.resets_at) * 1000; // source is epoch SECONDS
  let usedPercent = clampPercent(toNum(raw.used_percent));

  // STALENESS: once the reset moment has passed, the snapshot's used_percent is from the prior window —
  // the quota has rolled over, so report it as fully remaining and project the reset boundary forward.
  if (resetsAtMs > 0 && resetsAtMs < nowMs) {
    usedPercent = 0;
    if (windowMs > 0) {
      const periods = Math.ceil((nowMs - resetsAtMs) / windowMs);
      resetsAtMs += periods * windowMs;
    } else {
      resetsAtMs = 0;
    }
  }

  return {
    key,
    used_percent: usedPercent,
    remaining_percent: clampPercent(100 - usedPercent),
    window_minutes: windowMinutes,
    resets_at: resetsAtMs,
  };
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

/** Skip files whose mtime is older than `windowMs` before `nowMs` — they hold no fresh snapshot. */
function modifiedWithin(file: string, nowMs: number, windowMs: number): boolean {
  try {
    return nowMs - fs.statSync(file).mtimeMs <= windowMs;
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

/** Like `num` but allows 0 / negatives through (used_percent and resets_at can legitimately be 0). */
function toNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Clamp a percentage into the inclusive 0..100 range; non-finite → 0. */
function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
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
    rate_limits?: RawRateLimits;
  };
}

/** Codex `payload.rate_limits` — two windows; fields are floats / epoch SECONDS. */
interface RawRateLimits {
  primary?: RawWindow;
  secondary?: RawWindow;
}

interface RawWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}
