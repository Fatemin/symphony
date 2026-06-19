import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';

const env = setupEnv();

// Read env at call time → safe to import once and override CLAUDE_CONFIG_DIR / CODEX_HOME per test.
const { readLocalUsage } = await import('../src/server/usage/localUsage');
const { usageRoutes } = await import('../src/server/http/routes/usage');

test.after(() => env.cleanup());

const TODAY = new Date().toISOString();
// Two days back so a run near local midnight can never land it on "today".
const YESTERDAY = new Date(Date.now() - 2 * 86_400_000).toISOString();

// Rate-limit reset times are epoch SECONDS in the source. SOON/WEEK are future (live windows); PAST has
// already rolled over (the staleness case).
const nowSec = Math.floor(Date.now() / 1000);
const SOON = nowSec + 3 * 3600; // 3h ahead → the short window's reset
const WEEK = nowSec + 6 * 86_400; // ~6 days ahead → the weekly window's reset
const PAST = nowSec - 3600; // 1h ago → rolled over since the snapshot

/** Write JSONL — raw strings pass through verbatim (so a malformed line can be injected). */
function writeJsonl(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, `${body}\n`);
}

function claudeFixture(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(env.root, 'claude-'));
  writeJsonl(path.join(dir, 'projects', 'proj', 'session.jsonl'), lines);
  return dir;
}

function codexFixture(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(env.root, 'codex-'));
  writeJsonl(path.join(dir, 'sessions', '2026', '06', 'rollout-2026-06-19T00-00-00-abc.jsonl'), lines);
  return dir;
}

const claudeAssistant = (id: string, requestId: string, timestamp: string, usage: object) => ({
  type: 'assistant',
  timestamp,
  requestId,
  message: { id, usage },
});

const codexTokenCount = (
  timestamp: string,
  last: object,
  opts: { total?: object; rateLimits?: object } = {},
) => ({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { last_token_usage: last, total_token_usage: opts.total ?? {} },
    ...(opts.rateLimits ? { rate_limits: opts.rateLimits } : {}),
  },
});

const win = (used_percent: number, window_minutes: number, resets_at: number) => ({
  used_percent,
  window_minutes,
  resets_at,
});

const usageFor = (agents: Awaited<ReturnType<typeof readLocalUsage>>, agent: string) => {
  const row = agents.find((a) => a.agent === agent);
  assert.ok(row, `missing ${agent} row`);
  return row;
};

const windowFor = (agents: Awaited<ReturnType<typeof readLocalUsage>>, key: 'primary' | 'secondary') => {
  const w = usageFor(agents, 'codex').windows?.find((x) => x.key === key);
  assert.ok(w, `missing codex ${key} window`);
  return w;
};

test('Claude: dedups repeated flushes, sums today only — status unsupported, usage kept for tooltip', async () => {
  // Remaining isn't available for Claude locally → status 'unsupported'. The same message flushed 3×
  // counts once; a second message counts; yesterday/malformed/non-assistant lines are excluded — so
  // today's usage is still aggregated for the tooltip even though no remaining is reported.
  const dup = claudeAssistant('msg1', 'req1', TODAY, {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
  });
  process.env.CLAUDE_CONFIG_DIR = claudeFixture([
    dup,
    dup,
    dup,
    claudeAssistant('msg2', 'req2', TODAY, { input_tokens: 200, output_tokens: 80 }),
    claudeAssistant('old', 'reqOld', YESTERDAY, { input_tokens: 9999, output_tokens: 9999 }),
    '{ this is not json',
    { type: 'user', timestamp: TODAY, message: { content: 'hi' } },
  ]);
  process.env.CODEX_HOME = path.join(env.root, 'no-codex-here');

  const agents = await readLocalUsage();
  const claude = usageFor(agents, 'claude');
  assert.equal(claude.status, 'unsupported');
  assert.equal(claude.windows, undefined); // Claude never carries remaining windows
  assert.deepEqual(claude.usage, {
    input_tokens: 300, // 100 (deduped) + 200
    output_tokens: 130, // 50 + 80
    cache_read_tokens: 10,
    cache_creation_tokens: 5,
    total_tokens: 445, // 300 + 130 + 10 + 5
  });

  // The other agent's dir is absent → not_found, proving per-agent isolation.
  assert.equal(usageFor(agents, 'codex').status, 'not_found');
});

test('Claude: dir found but no usage today is still unsupported (not empty)', async () => {
  process.env.CLAUDE_CONFIG_DIR = claudeFixture([
    claudeAssistant('old', 'reqOld', YESTERDAY, { input_tokens: 500, output_tokens: 100 }),
  ]);
  process.env.CODEX_HOME = path.join(env.root, 'definitely-missing');

  const agents = await readLocalUsage();
  const claude = usageFor(agents, 'claude');
  assert.equal(claude.status, 'unsupported');
  assert.equal(claude.usage.total_tokens, 0);
  assert.equal(usageFor(agents, 'codex').status, 'not_found');
});

test('Codex: today usage + remaining windows, remaining = 100 − used, latest snapshot wins', async () => {
  // The newer-timestamp line appears FIRST and the older one SECOND, so asserting the newer values win
  // proves the latest is picked by timestamp (not file order). Usage is summed per-turn, today only.
  process.env.CLAUDE_CONFIG_DIR = path.join(env.root, 'no-claude-here');
  process.env.CODEX_HOME = codexFixture([
    codexTokenCount(
      TODAY,
      { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 },
      {
        total: { input_tokens: 9999, output_tokens: 9999 }, // cumulative — must be ignored
        rateLimits: { primary: win(11, 300, SOON), secondary: win(2, 10080, WEEK) },
      },
    ),
    // Older snapshot (would give remaining 1% if order, not timestamp, decided the winner).
    codexTokenCount(YESTERDAY, { input_tokens: 1, output_tokens: 1 }, {
      rateLimits: { primary: win(99, 300, SOON), secondary: win(99, 10080, WEEK) },
    }),
  ]);

  const agents = await readLocalUsage();
  const codex = usageFor(agents, 'codex');
  assert.equal(codex.status, 'ok');
  assert.deepEqual(codex.usage, {
    input_tokens: 100, // only TODAY's per-turn line
    output_tokens: 50, // 40 + 10 reasoning folded in
    cache_read_tokens: 20,
    cache_creation_tokens: 0,
    total_tokens: 170,
  });

  const primary = windowFor(agents, 'primary');
  assert.equal(primary.used_percent, 11);
  assert.equal(primary.remaining_percent, 89);
  assert.equal(primary.window_minutes, 300);
  assert.equal(primary.resets_at, SOON * 1000); // exposed as epoch MILLISECONDS

  const secondary = windowFor(agents, 'secondary');
  assert.equal(secondary.remaining_percent, 98); // 100 − 2
  assert.equal(secondary.window_minutes, 10080);
});

test('Codex: a window whose resets_at has passed rolls over to fully remaining', async () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(env.root, 'no-claude');
  process.env.CODEX_HOME = codexFixture([
    codexTokenCount(TODAY, { input_tokens: 5, output_tokens: 5 }, {
      rateLimits: { primary: win(80, 300, PAST), secondary: win(50, 10080, WEEK) },
    }),
  ]);

  const agents = await readLocalUsage();
  const primary = windowFor(agents, 'primary');
  assert.equal(primary.used_percent, 0); // rolled over since the snapshot
  assert.equal(primary.remaining_percent, 100);
  assert.ok(primary.resets_at > Date.now(), 'rolled-over reset is projected forward to the future');

  const secondary = windowFor(agents, 'secondary'); // still live → unchanged
  assert.equal(secondary.remaining_percent, 50);
});

test('Codex: dir found but no rate_limits snapshot is empty (usage still populated)', async () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(env.root, 'no-claude');
  process.env.CODEX_HOME = codexFixture([
    codexTokenCount(TODAY, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }),
  ]);

  const agents = await readLocalUsage();
  const codex = usageFor(agents, 'codex');
  assert.equal(codex.status, 'empty');
  assert.equal(codex.windows, undefined);
  assert.equal(codex.usage.total_tokens, 15); // tooltip totals survive the empty remaining state
});

test('error isolation: an unreadable root surfaces error without blanking the other agent', async () => {
  // Make <root> a real dir but <root>/projects a FILE → readdir throws ENOTDIR → status 'error'.
  const brokenClaude = fs.mkdtempSync(path.join(env.root, 'broken-claude-'));
  fs.writeFileSync(path.join(brokenClaude, 'projects'), 'not a directory');
  process.env.CLAUDE_CONFIG_DIR = brokenClaude;
  process.env.CODEX_HOME = codexFixture([
    codexTokenCount(TODAY, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }, {
      rateLimits: { primary: win(30, 300, SOON), secondary: win(10, 10080, WEEK) },
    }),
  ]);

  const agents = await readLocalUsage();
  const claude = usageFor(agents, 'claude');
  assert.equal(claude.status, 'error');
  assert.ok(claude.error && claude.error.length > 0, 'error carries a reason string');
  // Codex still aggregates normally — both usage and remaining windows.
  const codex = usageFor(agents, 'codex');
  assert.equal(codex.status, 'ok');
  assert.equal(codex.usage.total_tokens, 15);
  assert.equal(windowFor(agents, 'primary').remaining_percent, 70);
});

test('GET /local returns 200 with generated_at + both agent rows', async () => {
  process.env.CLAUDE_CONFIG_DIR = claudeFixture([
    claudeAssistant('m', 'r', TODAY, { input_tokens: 5, output_tokens: 5 }),
  ]);
  process.env.CODEX_HOME = path.join(env.root, 'no-codex');

  const res = await usageRoutes.request('/local');
  assert.equal(res.status, 200);
  const report = (await res.json()) as {
    generated_at: string;
    agents: { agent: string; status: string }[];
  };
  assert.match(report.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  const statuses = new Map(report.agents.map((a) => [a.agent, a.status]));
  assert.deepEqual([...statuses.keys()], ['claude', 'codex']);
  assert.equal(statuses.get('claude'), 'unsupported');
  assert.equal(statuses.get('codex'), 'not_found');
});
