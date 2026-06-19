import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { suggestProjectKey } = await import('../src/shared/keys');
const { deriveProjectKey } = await import('../src/server/core/keys');
const { projectRoutes } = await import('../src/server/http/routes/projects');
const { createProject } = await import('../src/server/repo/projects');
const { createIssue } = await import('../src/server/repo/issues');
const { createRun, finishRun } = await import('../src/server/repo/runs');

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

// ── GET /api/projects/:id derives current_phase per issue (SYM-32) ───────────

test('GET /api/projects/:id reports each in-progress issue\'s latest run phase as current_phase', async () => {
  const project = createProject({ name: 'Phase Board', key: 'PB', repo_path: env.repoPath });

  // In-progress issue with a multi-run history — the latest run (highest rowid) is qa.
  const active = createIssue({ project_id: project.id, title: 'Active', status: 'in_progress' });
  for (const phase of ['plan', 'implement', 'qa'] as const) {
    const run = createRun(active.id, phase, 1);
    finishRun(run.id, 'succeeded');
  }

  // A non-in_progress issue that *has* runs must still report null — phase is only board-relevant
  // while the issue is actively being worked.
  const reviewing = createIssue({ project_id: project.id, title: 'In review', status: 'review' });
  finishRun(createRun(reviewing.id, 'qa', 1).id, 'succeeded');

  // A never-run in_progress issue reports null (absent from the phase map).
  const fresh = createIssue({ project_id: project.id, title: 'Just started', status: 'in_progress' });

  const res = await projectRoutes.request(`/${project.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { issues: { id: string; current_phase: string | null }[] };
  const phaseOf = (id: string) => body.issues.find((i) => i.id === id)?.current_phase;

  assert.equal(phaseOf(active.id), 'qa', 'in-progress issue surfaces its latest run phase');
  assert.equal(phaseOf(reviewing.id), null, 'non-in_progress issue reports null even with runs');
  assert.equal(phaseOf(fresh.id), null, 'never-run in_progress issue reports null');
});
