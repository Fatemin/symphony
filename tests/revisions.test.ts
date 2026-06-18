import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';
import type { AgentRunInput } from '../src/server/agent/types';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { listRuns } = await import('../src/server/repo/runs');
const { listRevisions } = await import('../src/server/repo/revisions');
const { listEvents } = await import('../src/server/repo/events');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { issueRoutes } = await import('../src/server/http/routes/issues');
const { getOrchestrator } = await import('../src/server/orchestrator/orchestrator');

// The request-changes route re-dispatches round 2 through the orchestrator SINGLETON. Seed it with
// a fake runner (and capture its calls/inputs) before any route runs so round 2 stays offline.
const round2Calls = { plan: 0, implement: 0, qa: 0 };
const round2Inputs: AgentRunInput[] = [];
const orch = getOrchestrator({
  runner: makeFakeRunner({
    qa: 'pass',
    fileName: 'round2.txt',
    fileContent: 'round 2\n',
    calls: round2Calls,
    inputs: round2Inputs,
  }),
  getConfig: () => getConfig(),
});

test.after(() => {
  orch.stop();
  env.cleanup();
});

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

/** Drive an issue cold through plan→implement→qa to the review gate (round 1). */
async function createReviewedIssue(key: string) {
  const project = createProject({ name: `Rev ${key}`, key, repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: `Rev ${key}`, status: 'todo', mode: 'manual' });
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: `${key}.txt`, fileContent: `${key}\n` }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);
  const ready = getIssue(issue.id)!;
  assert.equal(ready.status, 'review');
  assert.equal(ready.round, 1);
  return ready;
}

test('request-changes starts round 2, re-runs every phase, and injects the feedback', async () => {
  const issue = await createReviewedIssue('RC');
  const feedback = 'The empty state copy is too long — tighten it and close the dialog on Escape.';

  // Empty feedback is rejected; the issue stays in review.
  const bad = await issueRoutes.request(`/${issue.id}/request-changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedback: '   ' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(getIssue(issue.id)!.status, 'review');
  assert.equal(getIssue(issue.id)!.round, 1);

  // Valid feedback opens round 2 and re-dispatches.
  const res = await issueRoutes.request(`/${issue.id}/request-changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedback }),
  });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { ok: boolean; round?: number };
  assert.equal(body.ok, true);
  assert.equal(body.round, 2);

  // Round + revision are recorded immediately; the event is emitted.
  assert.equal(getIssue(issue.id)!.round, 2);
  const revisions = listRevisions(issue.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.round, 2);
  assert.equal(revisions[0]!.feedback, feedback);
  assert.ok(listEvents({ issue_id: issue.id }).some((e) => e.kind === 'review.changes_requested'));

  // The background round-2 pipeline runs all three phases cold and parks back at review.
  await waitFor(() => getIssue(issue.id)!.status === 'review');
  assert.equal(round2Calls.plan, 1, 'plan must re-run in round 2');
  assert.equal(round2Calls.implement, 1, 'implement must re-run in round 2');
  assert.equal(round2Calls.qa, 1, 'qa must re-run in round 2');

  // Round-2 run rows exist for every phase (round-scoping prevented phase-skipping).
  const round2Runs = listRuns(issue.id).filter((r) => r.round === 2);
  assert.deepEqual(
    new Set(round2Runs.map((r) => r.phase)),
    new Set(['plan', 'implement', 'qa']),
  );

  // The feedback reached the plan prompt via the "Revision requested" block.
  const planInput = round2Inputs.find((i) => i.prompt.includes('**tech lead**'));
  assert.ok(planInput, 'a plan prompt should have been issued in round 2');
  assert.match(planInput!.prompt, /Revision requested \(round 2\)/);
  assert.ok(planInput!.prompt.includes(feedback), 'the feedback text must appear in the plan prompt');
});

test('request-changes is rejected with 409 unless the issue is awaiting review', async () => {
  const project = createProject({ name: 'Rev NR', key: 'NR', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Not in review', status: 'todo', mode: 'manual' });

  const res = await issueRoutes.request(`/${issue.id}/request-changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedback: 'change something' }),
  });
  assert.equal(res.status, 409);
  assert.equal(getIssue(issue.id)!.round, 1);
});
