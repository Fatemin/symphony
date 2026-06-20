import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import type { Issue, ReviewFinding, ReviewRun, ReviewRunWithFindings } from '../src/shared/types';
import type { AgentResult, AgentRunInput, AgentRunner } from '../src/server/agent/types';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { listIssues } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { buildReviewPrompt } = await import('../src/server/core/prompt');
const { executeReviewRun, reviewRoutes, __setReviewBackgroundRunner } = await import(
  '../src/server/http/routes/reviews'
);
const {
  createReviewRun,
  createReviewFinding,
  getReviewRun,
  listFindingsByRun,
  listReviewRunsWithFindings,
  countRunningReviews,
  failInterruptedReviewRuns,
} = await import('../src/server/repo/reviews');

test.after(() => env.cleanup());

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, num_turns: 1 };

/** A canned review reply that captures the input it was given, for read-only / cwd / agent asserts. */
function fakeRunner(text: string, sink?: { input?: AgentRunInput }, ok = true): AgentRunner {
  return async (input) => {
    if (sink) sink.input = input;
    return {
      ok,
      sessionId: 'review-sess',
      text,
      usage,
      durationMs: 1,
      error: ok ? undefined : 'boom',
    } as AgentResult;
  };
}

// Three findings: one valid critical bug, one valid low-severity doc feature, and one with garbage
// enums (category/type/severity all invalid, no description) to exercise the whitelist defaulting.
const REVIEW_REPLY = `Reviewed the project. A couple of things stand out.

\`\`\`symphony-review
{
  "summary": "Overall healthy; a few doc gaps and one risky path.",
  "findings": [
    { "category": "code", "type": "bug", "severity": "critical", "title": "Unbounded loop in worker", "description": "worker.ts can spin forever.", "acceptance_criteria": "- add a cap" },
    { "category": "docs", "type": "feature", "severity": "low", "title": "Document the env vars", "description": "README omits SYMPHONY_*.", "acceptance_criteria": "- list each var" },
    { "category": "weird", "type": "chore", "severity": "extreme", "title": "Tidy imports" }
  ]
}
\`\`\``;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function settle(cond: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('executeReviewRun runs read-only, parses + persists graded findings, and completes', async () => {
  const project = createProject({ name: 'Review Demo', key: 'REV', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'all', agent: 'claude' });
  const sink: { input?: AgentRunInput } = {};

  const done = await executeReviewRun(run, project, {
    runner: fakeRunner(REVIEW_REPLY, sink),
    config: getConfig(),
  });

  assert.equal(done.status, 'completed');
  assert.match(done.summary ?? '', /Overall healthy/);
  assert.equal(done.error, null);

  // Read-only, against the live repo, in plan mode, with the project's default (claude) agent.
  assert.equal(sink.input?.cwd, env.repoPath);
  assert.equal(sink.input?.permissionMode, 'plan');
  assert.equal(sink.input?.agent, 'claude');
  assert.equal(sink.input?.disableWorkflows, true);
  assert.match(sink.input!.prompt, /symphony-review/);

  // Findings persisted in report order with per-run seq 1..3.
  const findings = listFindingsByRun(run.id);
  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((f) => f.seq),
    [1, 2, 3],
  );
  assert.equal(findings[0]!.category, 'code');
  assert.equal(findings[0]!.severity, 'critical');
  assert.equal(findings[0]!.type, 'bug');
  assert.equal(findings[1]!.category, 'docs');
  assert.equal(findings[1]!.severity, 'low');
  // The garbage-enum finding is kept (it has a title) but every invalid field falls back to a default.
  assert.equal(findings[2]!.category, 'code');
  assert.equal(findings[2]!.type, 'feature');
  assert.equal(findings[2]!.severity, 'medium');
});

test('executeReviewRun completes with no findings when the reply has no usable fence', async () => {
  const project = createProject({ name: 'Review Empty', key: 'REVE', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'docs', agent: 'claude' });

  const done = await executeReviewRun(run, project, {
    runner: fakeRunner('Looks fine, nothing structured here.'),
    config: getConfig(),
  });

  // A malformed/empty reply is non-fatal: the run still completes, just with no findings.
  assert.equal(done.status, 'completed');
  assert.equal(listFindingsByRun(run.id).length, 0);
  assert.match(done.summary ?? '', /Looks fine/);
});

test('executeReviewRun marks the run failed when the agent errors', async () => {
  const project = createProject({ name: 'Review Fail', key: 'REVF', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'code', agent: 'claude' });

  const done = await executeReviewRun(run, project, {
    runner: fakeRunner('', undefined, false),
    config: getConfig(),
  });

  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'boom');
  assert.equal(listFindingsByRun(run.id).length, 0);
});

test('POST convert creates a severity-mapped issue and is idempotent', async () => {
  const project = createProject({ name: 'Review Convert', key: 'REVC', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'code', agent: 'claude' });
  const finding = createReviewFinding({
    review_run_id: run.id,
    project_id: project.id,
    category: 'code',
    type: 'bug',
    title: 'Fix the null deref',
    description: 'Crashes on empty input.',
    acceptance_criteria: '- guard the empty case',
    severity: 'critical',
  });

  const res = await reviewRoutes.request(`/${project.id}/reviews/findings/${finding.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'todo' }),
  });
  assert.equal(res.status, 201);
  const { issue, finding: updated } = (await res.json()) as { issue: Issue; finding: ReviewFinding };
  assert.equal(issue.type, 'bug');
  assert.equal(issue.status, 'todo');
  assert.equal(issue.priority, 1); // critical → urgent
  assert.equal(issue.title, 'Fix the null deref');
  assert.equal(updated.status, 'converted');
  assert.equal(updated.issue_id, issue.id);
  assert.equal(updated.issue_key, issue.key); // the LEFT JOIN surfaces the key for "Created KEY"

  // A second convert must not create a duplicate issue.
  const dup = await reviewRoutes.request(`/${project.id}/reviews/findings/${finding.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'todo' }),
  });
  assert.equal(dup.status, 409);
  assert.equal(listIssues(project.id).length, 1);
});

test('PATCH dismisses a draft, restores it, and refuses to mutate a converted finding', async () => {
  const project = createProject({ name: 'Review Dismiss', key: 'REVD', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'docs', agent: 'claude' });
  const finding = createReviewFinding({
    review_run_id: run.id,
    project_id: project.id,
    category: 'docs',
    type: 'feature',
    title: 'Nit to ignore',
    severity: 'low',
  });

  const dismissed = await reviewRoutes.request(`/${project.id}/reviews/findings/${finding.id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'dismissed' }),
  });
  assert.equal(dismissed.status, 200);
  assert.equal(((await dismissed.json()) as ReviewFinding).status, 'dismissed');

  const restored = await reviewRoutes.request(`/${project.id}/reviews/findings/${finding.id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'draft' }),
  });
  assert.equal(((await restored.json()) as ReviewFinding).status, 'draft');

  // A converted finding's status is owned by the convert flow — dismiss is rejected.
  const conv = createReviewFinding({
    review_run_id: run.id,
    project_id: project.id,
    category: 'code',
    type: 'bug',
    title: 'A real bug',
    severity: 'high',
  });
  await reviewRoutes.request(`/${project.id}/reviews/findings/${conv.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'backlog' }),
  });
  const blocked = await reviewRoutes.request(`/${project.id}/reviews/findings/${conv.id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'dismissed' }),
  });
  assert.equal(blocked.status, 409);
});

test('POST starts a background run (202) and GET lists the completed batch with findings', async () => {
  const project = createProject({ name: 'Review Route', key: 'REVR', repo_path: env.repoPath });
  // Inject the fake runner so the route's fire-and-forget execution never spawns a real CLI.
  __setReviewBackgroundRunner(fakeRunner(REVIEW_REPLY));
  try {
    const res = await reviewRoutes.request(`/${project.id}/reviews`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: 'all' }),
    });
    assert.equal(res.status, 202);
    const run = (await res.json()) as ReviewRun;
    assert.equal(run.status, 'running'); // the row is returned immediately, before execution finishes
    assert.equal(run.scope, 'all');

    // Let the background execution settle; it should complete with the fake's three findings.
    await settle(() => getReviewRun(run.id)?.status === 'completed');
    assert.equal(getReviewRun(run.id)?.status, 'completed');
    assert.equal(listFindingsByRun(run.id).length, 3);

    const list = (await (
      await reviewRoutes.request(`/${project.id}/reviews`)
    ).json()) as ReviewRunWithFindings[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.findings.length, 3);
  } finally {
    __setReviewBackgroundRunner(undefined);
  }
});

test('POST validates project / repo / scope and blocks a concurrent run (409)', async () => {
  // Unknown project → 404.
  const missing = await reviewRoutes.request('/nope/reviews', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ scope: 'all' }),
  });
  assert.equal(missing.status, 404);

  // Project without a repo → 400.
  const noRepo = createProject({ name: 'No Repo Review', key: 'NRR' });
  const noRepoRes = await reviewRoutes.request(`/${noRepo.id}/reviews`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ scope: 'all' }),
  });
  assert.equal(noRepoRes.status, 400);

  // Unknown scope → 400.
  const project = createProject({ name: 'Review Busy', key: 'REVB', repo_path: env.repoPath });
  const badScope = await reviewRoutes.request(`/${project.id}/reviews`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ scope: 'everything' }),
  });
  assert.equal(badScope.status, 400);

  // One concurrent review per project: a pre-existing running row blocks a new POST with 409
  // (and never reaches the agent, so no real CLI spawns).
  createReviewRun({ project_id: project.id, scope: 'code', agent: 'claude' });
  assert.equal(countRunningReviews(project.id), 1);
  const busy = await reviewRoutes.request(`/${project.id}/reviews`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ scope: 'all' }),
  });
  assert.equal(busy.status, 409);
  assert.equal(listReviewRunsWithFindings(project.id).length, 1); // no second run created
});

test('DELETE removes a batch and cascades its findings', async () => {
  const project = createProject({ name: 'Review Cascade', key: 'REVX', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'all', agent: 'claude' });
  createReviewFinding({
    review_run_id: run.id,
    project_id: project.id,
    category: 'code',
    type: 'bug',
    title: 'goes away with the run',
    severity: 'high',
  });

  const del = await reviewRoutes.request(`/${project.id}/reviews/${run.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal(getReviewRun(run.id), null);
  assert.equal(listFindingsByRun(run.id).length, 0); // ON DELETE CASCADE reclaimed the findings
});

test('buildReviewPrompt embeds the scope guidance, project context, and the review fence', () => {
  const project = createProject({
    name: 'Prompt Proj',
    key: 'PRP',
    repo_path: env.repoPath,
    context: 'A tiny CLI tool.',
  });

  const docs = buildReviewPrompt(project, 'docs');
  assert.match(docs, /symphony-review/);
  assert.match(docs, /READ-ONLY/);
  assert.match(docs, /documentation/i);
  assert.match(docs, /A tiny CLI tool\./); // project context is embedded

  const all = buildReviewPrompt(project, 'all');
  assert.match(all, /category/); // a full review tags each finding's category
  assert.match(all, /UI \/ UX/);
});

test('failInterruptedReviewRuns fails any run left running at boot', async () => {
  const project = createProject({ name: 'Review Boot', key: 'REVO', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'code', agent: 'claude' });
  assert.equal(getReviewRun(run.id)?.status, 'running');

  const failed = failInterruptedReviewRuns();
  assert.ok(failed >= 1);
  assert.equal(getReviewRun(run.id)?.status, 'failed');
  assert.match(getReviewRun(run.id)?.error ?? '', /restart/);
});
