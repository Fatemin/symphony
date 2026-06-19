import { execFileSync } from 'node:child_process';
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
 * SYM-38 / SYM-39 / SYM-40: read the LOCAL Claude Code / Codex CLI state for the sidebar footer widget.
 * SYM-39 repurposed the widget from token *usage* to **remaining** rate-limit quota (the user wants to
 * see what's left, not what's spent); SYM-40 made Claude show its real remaining, like Codex.
 *
 * Design points (verified against live CLI logs + the Claude usage endpoint):
 *  - Codex logs its live rate limits: each `token_count` event carries `payload.rate_limits` with a
 *    `primary` (short rolling) and `secondary` (weekly) window, each `{ used_percent, window_minutes,
 *    resets_at }`. We take the LATEST snapshot (max timestamp, any day) and report remaining = 100 −
 *    used. Both agents' windows share `normalizeWindow` (clamp + roll-over on a passed reset).
 *  - Claude persists NO remaining quota to its logs/caches — its `/usage` fetches it LIVE from an
 *    authenticated Anthropic endpoint. SYM-40 (round 3: "show Claude's remaining like Codex") makes a
 *    BEST-EFFORT live fetch of the SAME endpoint using the user's OWN local OAuth token (env →
 *    `<root>/.credentials.json` → macOS keychain): `GET <base>/api/oauth/usage` → map `five_hour` /
 *    `seven_day` → the same `RateWindow` shape, so the row renders identically to Codex. This is the
 *    ONE place the reader is no longer strictly no-network — it makes a single outbound GET to the
 *    fixed Anthropic host with the user's token (the same trust boundary as Claude Code itself; the
 *    token is never logged nor returned to the client). It still WRITES nothing, and every failure
 *    path (no token / expired / offline / non-200 / parse) degrades to `[]` → the row falls back to
 *    the old `unsupported` view (today's usage + a `/usage` hint), so nothing regresses for API-key
 *    users, headless servers, or when offline. A small TTL cache coalesces the bursty sidebar polls.
 *  - Today's token totals are still computed for the tooltip on both agents. "today" is the SERVER's
 *    local-machine day boundary — Symphony runs locally beside the CLIs, so timestamps share its clock.
 *  - Each agent root is scanned inside its OWN try/catch (`buildReport`) so a missing/locked Claude
 *    dir never blanks the Codex row and vice-versa — the endpoint always returns per-agent statuses.
 *    Genuine local FS errors bubble to `error`; the live fetch's own errors never do (they → `[]`).
 *  - Env overrides are read at CALL time (not import time) so tests can point CLAUDE_CONFIG_DIR /
 *    CODEX_HOME at throwaway dirs. Files are streamed line-by-line (they grow to multi-MB). Claude
 *    files are bounded to today's mtime; Codex files to ~8 days so the weekly snapshot stays visible.
 *    TEST-OFFLINE SAFETY: `setupEnv()` sets `SYMPHONY_DISABLE_KEYCHAIN=1` and clears the OAuth env
 *    token so `npm test` never reads the dev's real keychain/token; the one live-path test stubs fetch.
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
  // SYM-40: Claude is `ok` when the best-effort LIVE fetch (see scanClaude) returned remaining windows
  // — it then renders exactly like Codex. When the fetch couldn't run (no local token / expired /
  // offline / endpoint error) it yields no windows and the row falls back to `unsupported`: the UI
  // honestly headlines today's usage and points at `/usage`. Today's usage is computed for the tooltip
  // in BOTH cases. (Mirrors readCodexUsage's classify, minus the `empty` state.)
  return buildReport('claude', () => scanClaude(now), (r) =>
    r.windows && r.windows.length > 0 ? { status: 'ok', windows: r.windows } : { status: 'unsupported' },
  );
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
  /** Remaining windows: Codex's latest rate-limit snapshot, or Claude's live fetch; undefined/[] when none. */
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
  // SYM-40: best-effort LIVE remaining fetch. Only when a root exists (else the row is `not_found`
  // anyway). All of its own errors degrade to `[]` inside fetchClaudeRemaining, so the row falls back
  // to `unsupported` (+ today's usage); only the local FS walk above can mark the agent `error`.
  const windows = anyRootFound ? await fetchClaudeRemaining(now.getTime()) : [];
  return { anyRootFound, usage, windows };
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
  // Codex's resets_at is epoch SECONDS; convert to ms before handing to the shared normalizer.
  return normalizeWindow(key, toNum(raw.used_percent), toNum(raw.window_minutes), toNum(raw.resets_at) * 1000, nowMs);
}

/**
 * Normalize one remaining window from already-parsed numbers (shared by Codex and Claude — SYM-40).
 * Clamps `used_percent` to 0..100 and derives `remaining_percent`. STALENESS: once the reset moment has
 * passed, the snapshot's used_percent is from the PRIOR window — the quota has rolled over, so report it
 * as fully remaining and project the reset boundary forward. `resetsAtMs` is epoch MILLISECONDS (callers
 * convert their own units first); 0 means unknown.
 */
function normalizeWindow(
  key: 'primary' | 'secondary',
  usedPercentRaw: number,
  windowMinutesRaw: number,
  resetsAtMsRaw: number,
  nowMs: number,
): RateWindow {
  const windowMinutes = Math.max(0, Math.round(windowMinutesRaw));
  const windowMs = windowMinutes * 60_000;
  let resetsAtMs = resetsAtMsRaw;
  let usedPercent = clampPercent(usedPercentRaw);

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

// ── Claude live remaining (SYM-40) ───────────────────────────────────────────

/**
 * Claude persists no remaining quota locally, so we fetch it LIVE from the same endpoint `/usage` uses,
 * with the user's own local OAuth token. Best-effort: every error → `[]` (the row falls back to
 * `unsupported`). A small TTL cache coalesces the bursty sidebar polls (60s interval + per-issue
 * invalidations) so we don't hit the keychain/network on every refresh. The fixed Anthropic host is
 * overridable via ANTHROPIC_BASE_URL (for tests / proxies); read at call time.
 */
const CLAUDE_USAGE_PATH = '/api/oauth/usage';
const CLAUDE_FETCH_TIMEOUT_MS = 4_000;
const CLAUDE_FETCH_TTL_MS = 30_000;
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

let claudeCache: { at: number; windows: RateWindow[] } | null = null;

/** Test hook: clear the live-fetch cache between cases so a stubbed fetch isn't masked by a prior result. */
export function __resetClaudeUsageCache(): void {
  claudeCache = null;
}

/**
 * The remaining windows for Claude, cached for a short TTL. Returns `[]` (→ `unsupported`) whenever no
 * usable token is found (so a fresh login shows up on the next poll — the no-token case is NOT cached)
 * or the fetch fails. Cached on every actual attempt (success OR failure) to avoid hammering a flaky
 * endpoint across the bursty sidebar invalidations.
 */
async function fetchClaudeRemaining(nowMs: number): Promise<RateWindow[]> {
  if (claudeCache && nowMs - claudeCache.at < CLAUDE_FETCH_TTL_MS) return claudeCache.windows;
  const token = resolveClaudeToken(nowMs);
  if (!token) return [];
  const windows = await fetchClaudeWindows(token, nowMs);
  claudeCache = { at: nowMs, windows };
  return windows;
}

/** One outbound GET to the Anthropic usage endpoint; ALL errors (network/timeout/non-200/parse) → `[]`. */
async function fetchClaudeWindows(token: string, nowMs: number): Promise<RateWindow[]> {
  const base = (process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(`${base}${CLAUDE_USAGE_PATH}`, {
      method: 'GET',
      headers: {
        // The user's own OAuth credential, sent only to the fixed Anthropic host over HTTPS — the same
        // trust boundary as Claude Code itself. Never logged, never returned to the client.
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return mapClaudeUsage(await res.json(), nowMs);
  } catch {
    return []; // network/timeout/parse → degrade to the unsupported fallback
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map the usage endpoint's JSON to the shared `RateWindow` shape (pure aside from `nowMs` staleness).
 * `five_hour`→primary (300 min), `seven_day`→secondary (10080 min); `utilization` is USED percent and
 * `resets_at` an ISO-8601 string. Per-model weekly sub-limits (seven_day_opus/sonnet) are out of scope —
 * two windows match the Codex two-window UI; a per-model breakdown is a deferred follow-up.
 */
export function mapClaudeUsage(json: unknown, nowMs: number): RateWindow[] {
  const data = json as { five_hour?: unknown; seven_day?: unknown };
  const out: RateWindow[] = [];
  const primary = claudeWindow('primary', data?.five_hour, 300, nowMs);
  if (primary) out.push(primary);
  const secondary = claudeWindow('secondary', data?.seven_day, 10_080, nowMs);
  if (secondary) out.push(secondary);
  return out;
}

function claudeWindow(
  key: 'primary' | 'secondary',
  raw: unknown,
  windowMinutes: number,
  nowMs: number,
): RateWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  return normalizeWindow(key, toNum(w.utilization), windowMinutes, parseTs(w.resets_at) ?? 0, nowMs);
}

/** OAuth token + its expiry (epoch ms; 0 = unknown/no-expiry). */
interface ClaudeCreds {
  accessToken: string;
  expiresAt: number;
}

/** Resolve a non-expired access token, or null. Resolution order: env → .credentials.json → keychain. */
function resolveClaudeToken(nowMs: number): string | null {
  const creds = readClaudeCreds();
  if (!creds) return null;
  if (creds.expiresAt > 0 && creds.expiresAt < nowMs) return null; // expired → skip the fetch
  return creds.accessToken || null;
}

/**
 * Read the Claude OAuth credential read-only. Order: CLAUDE_CODE_OAUTH_TOKEN (headless/CI; no expiry) →
 * `<root>/.credentials.json` (Linux + the test fixtures) → macOS keychain. We never refresh or write it.
 */
function readClaudeCreds(): ClaudeCreds | null {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return { accessToken: envToken, expiresAt: 0 };

  for (const root of claudeRoots()) {
    const creds = parseCreds(readFileSafe(path.join(root, '.credentials.json')));
    if (creds) return creds;
  }

  // The keychain is the macOS storage; gated off in tests (SYMPHONY_DISABLE_KEYCHAIN) so `npm test`
  // never reads the developer's real token.
  if (process.platform === 'darwin' && !keychainDisabled()) {
    const creds = parseCreds(readKeychainBlob());
    if (creds) return creds;
  }
  return null;
}

function keychainDisabled(): boolean {
  const v = process.env.SYMPHONY_DISABLE_KEYCHAIN?.trim();
  return v === '1' || v === 'true';
}

/** macOS keychain blob for the Claude OAuth credential. Fixed args (no injection); any failure → null. */
function readKeychainBlob(): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not present / locked / no keychain → fall through
  }
}

function readFileSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // missing/unreadable → next source
  }
}

/** Parse `{ claudeAiOauth: { accessToken, expiresAt } }` (the shape of both the file and keychain blob). */
function parseCreds(raw: string | null): ClaudeCreds | null {
  if (!raw) return null;
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } })
      ?.claudeAiOauth;
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
    if (!accessToken) return null;
    const expiresAt =
      typeof oauth?.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : 0;
    return { accessToken, expiresAt };
  } catch {
    return null;
  }
}

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
