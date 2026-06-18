import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue, setStatus } = await import('../src/server/repo/issues');
const { listEvents } = await import('../src/server/repo/events');
const { listRuns } = await import('../src/server/repo/runs');
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

test('a manually-run issue retries a transient failure instead of dropping it', async () => {
  const project = createProject({ name: 'ManualRetry', key: 'MR', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Manual run, one flaky phase',
    status: 'todo',
    mode: 'manual',
  });

  const config = () => ({ ...getConfig(), max_attempts: 3, max_retry_backoff_ms: 50 });
  const orch = new Orchestrator({
    tracker: localTracker,
    runner: makeFakeRunner({ failOncePhase: 'implement' }),
    getConfig: config,
  });

  // Manual issues never enter via the poll loop — only via the Run button (runNow).
  assert.equal(orch.runNow(issue.id).ok, true);
  await waitFor(() => getIssue(issue.id)!.status === 'review', 8000);

  const attempts = listRuns(issue.id).map((r) => r.attempt);
  assert.ok(attempts.includes(2), 'attempt 2 should have run after the transient failure');
  assert.equal(getIssue(issue.id)!.mode, 'manual', 'retrying must not flip the mode');

  orch.stop();
});

test('a queued retry for a no-longer-active issue is dropped with an event, not silently', async () => {
  const project = createProject({ name: 'DropRetry', key: 'DR', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Cancelled while a retry is queued',
    status: 'todo',
    mode: 'auto',
  });

  // A 500ms backoff keeps the retry queued long enough to cancel the issue under it.
  const config = () => ({ ...getConfig(), max_attempts: 3, max_retry_backoff_ms: 500 });
  const orch = new Orchestrator({
    tracker: localTracker,
    runner: makeFakeRunner({ failPhase: 'implement' }),
    getConfig: config,
  });

  await orch.kick();
  await waitFor(() => orch.snapshot().retrying.length === 1, 8000);
  setStatus(issue.id, 'cancelled');

  await waitFor(
    () => listEvents({ issue_id: issue.id }).some((e) => e.kind === 'orchestrator.drop'),
    8000,
  );

  const drop = listEvents({ issue_id: issue.id }).find((e) => e.kind === 'orchestrator.drop')!;
  assert.match(drop.message, /cancelled/);
  assert.equal(orch.snapshot().retrying.length, 0, 'claim and timer must be released');

  orch.stop();
});

test('quota failures pause and retry without consuming attempts', async () => {
  const project = createProject({ name: 'Quota', key: 'QT', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Waits for quota reset',
    status: 'todo',
    mode: 'auto',
  });

  const config = () => ({ ...getConfig(), max_attempts: 1, max_retry_backoff_ms: 20 });
  const orch = new Orchestrator({
    tracker: localTracker,
    runner: makeFakeRunner({ quotaOncePhase: 'plan', quotaRetryAfterMs: 1 }),
    getConfig: config,
  });

  await orch.kick();
  await waitFor(() => getIssue(issue.id)!.status === 'review', 8000);

  const attempts = listRuns(issue.id).map((r) => r.attempt);
  assert.ok(attempts.length >= 4, 'quota retry should still complete the full pipeline');
  assert.ok(attempts.every((a) => a === 1), 'quota retry must not advance attempts');
  assert.equal(getIssue(issue.id)!.mode, 'auto');

  orch.stop();
});
