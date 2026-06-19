import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { suggestProjectKey } = await import('../src/shared/keys');
const { deriveProjectKey } = await import('../src/server/core/keys');
const { projectRoutes } = await import('../src/server/http/routes/projects');

test.after(() => env.cleanup());

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ── suggestProjectKey / deriveProjectKey (pure, offline) ─────────────────────

test('suggestProjectKey takes the uppercase letters of the name, first three', () => {
  assert.equal(suggestProjectKey('ops-supplier'), 'OPS');
  assert.equal(suggestProjectKey('Web App'), 'WEB');
  assert.equal(suggestProjectKey('  hello world '), 'HEL');
  // Fewer than three letters yields a short (or empty) deterministic prefix.
  assert.equal(suggestProjectKey('A1'), 'A');
  assert.equal(suggestProjectKey('123'), '');
  assert.equal(suggestProjectKey(''), '');
});

test('deriveProjectKey reuses the shared prefix and pads short/empty names to three', () => {
  assert.equal(deriveProjectKey('ops-supplier'), 'OPS');
  // A name with too few letters still resolves to a 3-char key (random suffix).
  for (const name of ['A1', '', '12']) {
    assert.match(deriveProjectKey(name), /^[A-Z]{3}$/);
  }
});

// ── POST /api/projects collision → 409 (via the Hono router, offline) ────────

test('POST /api/projects translates a duplicate key collision to a friendly 409', async () => {
  // First project claims the derived key OPS.
  let res = await projectRoutes.request('/', json({ name: 'ops-supplier', repo_path: env.repoPath }));
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { key: string }).key, 'OPS');

  // A second project whose name derives the same key must NOT 500 — it returns a 409 + message.
  res = await projectRoutes.request('/', json({ name: 'ops-something-else', key: 'OPS' }));
  assert.equal(res.status, 409);
  const dup = (await res.json()) as { error: string };
  assert.match(dup.error, /already exists/);

  // missing name → 400 (unchanged guard, never reaches the INSERT)
  res = await projectRoutes.request('/', json({ key: 'XYZ' }));
  assert.equal(res.status, 400);

  // A distinct key still succeeds.
  res = await projectRoutes.request('/', json({ name: 'ops-supplier', key: 'OP2' }));
  assert.equal(res.status, 201);
});
