import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue, setStatus } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { localTracker } = await import('../src/server/tracker/localTracker');
const { Orchestrator } = await import('../src/server/orchestrator/orchestrator');

test.after(() => env.cleanup());

/** Poll a predicate until true or timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

test('orchestrator picks up an auto issue, drives it to review, and stops there', async () => {
  const project = createProject({ name: 'Orch', key: 'OR', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Auto issue',
    status: 'todo',
    mode: 'auto',
  });

  const orch = new Orchestrator({
    tracker: localTracker,
    runner: makeFakeRunner({ qa: 'pass' }),
    getConfig: () => getConfig(),
  });

  // Force one tick; the poll loop should dispatch the candidate on its own.
  await orch.kick();
  await waitFor(() => getIssue(issue.id)!.status === 'review');

  const snap = orch.snapshot();
  assert.equal(snap.running.length, 0, 'run should have completed');
  assert.equal(getIssue(issue.id)!.status, 'review');

  // Human acknowledges → done. Another tick must NOT re-dispatch a terminal issue.
  setStatus(issue.id, 'done');
  await orch.kick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(orch.snapshot().running.length, 0, 'terminal issue must not be re-picked');
  assert.equal(getIssue(issue.id)!.status, 'done');

  orch.stop();
});

test('orchestrator gives up after max attempts and parks the issue to manual', async () => {
  const project = createProject({ name: 'Giveup', key: 'GU', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Always fails QA',
    status: 'todo',
    mode: 'auto',
  });

  // max_attempts defaults to 3; a failing runner forces give-up. Use a tiny backoff config.
  const config = () => ({ ...getConfig(), max_attempts: 2, max_retry_backoff_ms: 50 });
  const orch = new Orchestrator({
    tracker: localTracker,
    runner: makeFakeRunner({ failPhase: 'implement' }),
    getConfig: config,
  });

  await orch.kick();
  // After attempt 1 fails → retry scheduled (≤50ms) → attempt 2 fails → give up → mode manual.
  await waitFor(() => getIssue(issue.id)!.mode === 'manual', 8000);

  const issueNow = getIssue(issue.id)!;
  assert.equal(issueNow.mode, 'manual');
  assert.equal(orch.snapshot().running.length, 0);

  orch.stop();
});
