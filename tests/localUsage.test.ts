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

const codexTokenCount = (timestamp: string, last: object, total: object = {}) => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } },
});

const usageFor = (agents: Awaited<ReturnType<typeof readLocalUsage>>, agent: string) => {
  const row = agents.find((a) => a.agent === agent);
  assert.ok(row, `missing ${agent} row`);
  return row;
};

test('Claude: dedups repeated flushes, sums today only, skips malformed + non-assistant lines', async () => {
  // The same message is flushed 3× identically — must be counted once. A second distinct message
  // counts. A yesterday message, a malformed line, and a non-assistant line are all excluded.
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
  assert.equal(claude.status, 'ok');
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

test('Codex: sums per-turn last_token_usage (NOT cumulative total), today only', async () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(env.root, 'no-claude-here');
  process.env.CODEX_HOME = codexFixture([
    codexTokenCount(
      TODAY,
      { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 },
      { input_tokens: 9999, output_tokens: 9999 }, // cumulative — must be ignored
    ),
    codexTokenCount(TODAY, { input_tokens: 50, cached_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0 }),
    codexTokenCount(YESTERDAY, { input_tokens: 1234, cached_input_tokens: 1234, output_tokens: 1234 }),
    { timestamp: TODAY, type: 'turn_context', payload: { model: 'gpt-5' } }, // non-usage line ignored
  ]);

  const agents = await readLocalUsage();
  const codex = usageFor(agents, 'codex');
  assert.equal(codex.status, 'ok');
  assert.deepEqual(codex.usage, {
    input_tokens: 150, // 100 + 50
    output_tokens: 80, // (40+10) + (30+0) — reasoning folded into output
    cache_read_tokens: 20, // 20 + 0
    cache_creation_tokens: 0,
    total_tokens: 250, // 150 + 80 + 20
  });
  assert.equal(usageFor(agents, 'claude').status, 'not_found');
});

test('empty vs not_found: an existing dir with no today usage is empty, a missing dir is not_found', async () => {
  // Claude dir exists but only has a yesterday message → empty (detected, 0 today).
  process.env.CLAUDE_CONFIG_DIR = claudeFixture([
    claudeAssistant('old', 'reqOld', YESTERDAY, { input_tokens: 500, output_tokens: 100 }),
  ]);
  process.env.CODEX_HOME = path.join(env.root, 'definitely-missing');

  const agents = await readLocalUsage();
  const claude = usageFor(agents, 'claude');
  assert.equal(claude.status, 'empty');
  assert.equal(claude.usage.total_tokens, 0);
  assert.equal(usageFor(agents, 'codex').status, 'not_found');
});

test('error isolation: an unreadable root surfaces error without blanking the other agent', async () => {
  // Make <root> a real dir but <root>/projects a FILE → readdir throws ENOTDIR → status 'error'.
  const brokenClaude = fs.mkdtempSync(path.join(env.root, 'broken-claude-'));
  fs.writeFileSync(path.join(brokenClaude, 'projects'), 'not a directory');
  process.env.CLAUDE_CONFIG_DIR = brokenClaude;
  process.env.CODEX_HOME = codexFixture([
    codexTokenCount(TODAY, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }),
  ]);

  const agents = await readLocalUsage();
  const claude = usageFor(agents, 'claude');
  assert.equal(claude.status, 'error');
  assert.ok(claude.error && claude.error.length > 0, 'error carries a reason string');
  // Codex still aggregates normally.
  assert.equal(usageFor(agents, 'codex').status, 'ok');
  assert.equal(usageFor(agents, 'codex').usage.total_tokens, 15);
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
  assert.equal(statuses.get('claude'), 'ok');
  assert.equal(statuses.get('codex'), 'not_found');
});
