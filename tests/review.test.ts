import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import type { BoardIssue, Issue, ReviewFinding, ReviewRun, ReviewRunWithFindings } from '../src/shared/types';
import type { AgentResult, AgentRunInput, AgentRunner } from '../src/server/agent/types';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { listIssues, listAutoCandidates } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { getOrchestrator } = await import('../src/server/orchestrator/orchestrator');
const { buildReviewPrompt } = await import('../src/server/core/prompt');
const { executeReviewRun, reviewRoutes, __setReviewBackgroundRunner } = await import(
  '../src/server/http/routes/reviews'
);
const { projectRoutes } = await import('../src/server/http/routes/projects');
const {
  createReviewRun,
  createReviewFinding,
  getReviewRun,
  listFindingsByRun,
  listReviewRunsWithFindings,
  countRunningReviews,
  deleteReviewRun,
  failInterruptedReviewRuns,
} = await import('../src/server/repo/reviews');

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

/** Create a draft finding on a run with sensible defaults — trims the boilerplate in the batch tests. */
function addFinding(
  runId: string,
  projectId: string,
  severity: ReviewFinding['severity'],
  title: string,
  type: 'feature' | 'bug' = 'feature',
): ReviewFinding {
  return createReviewFinding({ review_run_id: runId, project_id: projectId, category: 'code', type, title, severity });
}

// SYM-66: the batch-convert route kicks the orchestrator SINGLETON so newly-created auto issues
// dispatch promptly. Seed it DISABLED here so that kick is a safe no-op (tick reconciles then early
// returns — no candidate fetch, no worktree, no real CLI). This suite tests conversion, not scheduling.
const orch = getOrchestrator({
  runner: fakeRunner('orchestrator stays idle in this suite'),
  getConfig: () => ({ ...getConfig(), enabled: false }),
});

test.after(() => {
  orch.stop();
  env.cleanup();
});

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

test('POST batch convert turns all drafts into auto issues, skips converted/dismissed, and is idempotent', async () => {
  const project = createProject({ name: 'Review Batch', key: 'RVB', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'all', agent: 'claude' });
  const crit = addFinding(run.id, project.id, 'critical', 'Critical bug', 'bug');
  addFinding(run.id, project.id, 'high', 'High feature');
  addFinding(run.id, project.id, 'low', 'Low nit');
  const dismissed = addFinding(run.id, project.id, 'medium', 'To dismiss');
  const preConv = addFinding(run.id, project.id, 'high', 'Already converted', 'bug');

  // Pre-dismiss one finding and pre-convert another (the single-convert flow) — both must be skipped.
  await reviewRoutes.request(`/${project.id}/reviews/findings/${dismissed.id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'dismissed' }),
  });
  await reviewRoutes.request(`/${project.id}/reviews/findings/${preConv.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'todo' }),
  });

  // Batch convert with no body → defaults to mode='auto', status='todo'.
  const res = await reviewRoutes.request(`/${project.id}/reviews/${run.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
  const { issues, converted } = (await res.json()) as { issues: Issue[]; converted: number };
  // Only the three still-draft findings convert — the dismissed + already-converted ones are skipped.
  assert.equal(converted, 3);
  assert.equal(issues.length, 3);
  for (const issue of issues) {
    assert.equal(issue.mode, 'auto'); // the feature: orchestrator-eligible by default
    assert.equal(issue.status, 'todo');
  }
  // Severity → priority + type carried through from each finding.
  const byTitle = new Map(issues.map((i) => [i.title, i]));
  assert.equal(byTitle.get('Critical bug')!.priority, 1);
  assert.equal(byTitle.get('Critical bug')!.type, 'bug');
  assert.equal(byTitle.get('High feature')!.priority, 2);
  assert.equal(byTitle.get('Low nit')!.priority, 4);

  // The converted findings flip to 'converted' with their issue linked; dismissed stays dismissed.
  const after = listFindingsByRun(run.id);
  assert.equal(after.filter((f) => f.status === 'converted').length, 4); // 3 batch + 1 pre-converted
  assert.equal(after.find((f) => f.id === crit.id)!.issue_id, byTitle.get('Critical bug')!.id);
  assert.equal(after.find((f) => f.id === dismissed.id)!.status, 'dismissed');

  // The created auto issues are orchestrator-eligible (mode='auto' AND status in todo/in_progress).
  const candidateTitles = listAutoCandidates().map((i) => i.title);
  assert.ok(candidateTitles.includes('Critical bug'));
  assert.ok(candidateTitles.includes('High feature'));
  assert.ok(candidateTitles.includes('Low nit'));

  // Idempotent: a re-click finds no remaining drafts → converted 0, and creates no duplicate issues.
  const before = listIssues(project.id).length;
  const again = await reviewRoutes.request(`/${project.id}/reviews/${run.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(again.status, 201);
  assert.equal(((await again.json()) as { converted: number }).converted, 0);
  assert.equal(listIssues(project.id).length, before);
});

test('POST batch convert honors the finding_ids filter and mode/status overrides', async () => {
  const project = createProject({ name: 'Review Batch Opts', key: 'RVBO', repo_path: env.repoPath });
  const run = createReviewRun({ project_id: project.id, scope: 'code', agent: 'claude' });
  const a = addFinding(run.id, project.id, 'critical', 'Convert me A', 'bug');
  const b = addFinding(run.id, project.id, 'high', 'Leave me B');
  const c = addFinding(run.id, project.id, 'medium', 'Convert me C');

  // Filter to [a, c] and override to manual triage parked in the backlog.
  const res = await reviewRoutes.request(`/${project.id}/reviews/${run.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ finding_ids: [a.id, c.id], mode: 'manual', status: 'backlog' }),
  });
  assert.equal(res.status, 201);
  const { issues, converted } = (await res.json()) as { issues: Issue[]; converted: number };
  assert.equal(converted, 2);
  for (const issue of issues) {
    assert.equal(issue.mode, 'manual'); // override honored
    assert.equal(issue.status, 'backlog');
  }
  // b was not in the filter, so it remains an unconverted draft (and not auto-dispatched).
  const after = listFindingsByRun(run.id);
  assert.equal(after.find((f) => f.id === b.id)!.status, 'draft');
  assert.equal(after.find((f) => f.id === a.id)!.status, 'converted');
  assert.ok(!listAutoCandidates().some((i) => i.title === 'Convert me A')); // manual ⇒ not a candidate
});

test('POST batch convert 404s an unknown/foreign run and returns 0 for a run with no drafts', async () => {
  const project = createProject({ name: 'Review Batch Edge', key: 'RVBE', repo_path: env.repoPath });

  // Unknown run id → 404.
  const missing = await reviewRoutes.request(`/${project.id}/reviews/nope/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 404);

  // A run that belongs to another project → 404 (no cross-project conversion).
  const other = createProject({ name: 'Review Batch Other', key: 'RVBX', repo_path: env.repoPath });
  const otherRun = createReviewRun({ project_id: other.id, scope: 'all', agent: 'claude' });
  const foreign = await reviewRoutes.request(`/${project.id}/reviews/${otherRun.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(foreign.status, 404);

  // A run with no draft findings → 201 with converted: 0 (the button is a no-op, not an error).
  const emptyRun = createReviewRun({ project_id: project.id, scope: 'all', agent: 'claude' });
  const empty = await reviewRoutes.request(`/${project.id}/reviews/${emptyRun.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 201);
  assert.equal(((await empty.json()) as { converted: number }).converted, 0);
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

test('both convert paths stamp source=review + source_run_id on the created issue (SYM-78)', async () => {
  const project = createProject({ name: 'Provenance Convert', key: 'PVC', repo_path: env.repoPath });

  // Per-finding convert → the run that owns the finding.
  const run1 = createReviewRun({ project_id: project.id, scope: 'code', agent: 'claude' });
  const finding = addFinding(run1.id, project.id, 'high', 'Single convert', 'bug');
  const single = await reviewRoutes.request(`/${project.id}/reviews/findings/${finding.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: 'todo' }),
  });
  assert.equal(single.status, 201);
  const { issue } = (await single.json()) as { issue: Issue };
  assert.equal(issue.source, 'review');
  assert.equal(issue.source_run_id, run1.id);

  // Batch convert → every created issue carries the batch run id.
  const run2 = createReviewRun({ project_id: project.id, scope: 'docs', agent: 'claude' });
  addFinding(run2.id, project.id, 'critical', 'Batch A', 'bug');
  addFinding(run2.id, project.id, 'low', 'Batch B');
  const batch = await reviewRoutes.request(`/${project.id}/reviews/${run2.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(batch.status, 201);
  const { issues } = (await batch.json()) as { issues: Issue[] };
  assert.equal(issues.length, 2);
  for (const i of issues) {
    assert.equal(i.source, 'review');
    assert.equal(i.source_run_id, run2.id);
  }
});

test('the board derives source_label from the run scope and survives the run deletion (SYM-78)', async () => {
  const project = createProject({ name: 'Board Label', key: 'BDL', repo_path: env.repoPath });
  // A hand-made issue has no provenance label; a converted one inherits the batch scope.
  const { createIssue } = await import('../src/server/repo/issues');
  const manualIssue = createIssue({ project_id: project.id, title: 'typed by hand' });

  const run = createReviewRun({ project_id: project.id, scope: 'ui_ux', agent: 'claude' });
  addFinding(run.id, project.id, 'high', 'From the review', 'bug');
  await reviewRoutes.request(`/${project.id}/reviews/${run.id}/convert`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });

  const board = await projectRoutes.request(`/${project.id}`);
  assert.equal(board.status, 200);
  const { issues } = (await board.json()) as { issues: BoardIssue[] };
  const converted = issues.find((i) => i.source === 'review')!;
  assert.equal(converted.source_run_id, run.id);
  assert.equal(converted.source_label, 'Review · UI / UX'); // scope → server-side label
  const stayedManual = issues.find((i) => i.id === manualIssue.id)!;
  assert.equal(stayedManual.source, 'manual');
  assert.equal(stayedManual.source_label, null);

  // Deleting the batch keeps the issue (soft pointer survives) but drops the resolvable label —
  // the client then falls back to a generic 'Review' while still grouping by source_run_id.
  deleteReviewRun(run.id);
  const board2 = await projectRoutes.request(`/${project.id}`);
  const after = ((await board2.json()) as { issues: BoardIssue[] }).issues.find((i) => i.source === 'review')!;
  assert.equal(after.source_run_id, run.id); // pointer survives
  assert.equal(after.source_label, null); // run gone ⇒ no derivable label
});
