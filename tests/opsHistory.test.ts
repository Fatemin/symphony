import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue } = await import('../src/server/repo/issues');
const { createRun, updateRunUsage, finishRun, listIssueHistory } = await import(
  '../src/server/repo/runs'
);

test.after(() => env.cleanup());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('listIssueHistory aggregates runs per issue, recent-first, and scopes by project', async () => {
  const project = createProject({ name: 'History', key: 'HI', repo_path: env.repoPath });

  // Issue A: a full multi-attempt pipeline. Latest run (highest rowid) is the qa success.
  const a = createIssue({ project_id: project.id, title: 'Rich history', status: 'review' });
  const runsA: Array<{ phase: 'plan' | 'implement' | 'qa'; attempt: number; status: 'succeeded' | 'failed'; tokens: number; turns: number }> = [
    { phase: 'plan', attempt: 1, status: 'succeeded', tokens: 100, turns: 2 },
    { phase: 'implement', attempt: 1, status: 'failed', tokens: 200, turns: 3 },
    { phase: 'implement', attempt: 2, status: 'succeeded', tokens: 300, turns: 4 },
    { phase: 'qa', attempt: 2, status: 'succeeded', tokens: 50, turns: 1 },
  ];
  for (const r of runsA) {
    const run = createRun(a.id, r.phase, r.attempt);
    updateRunUsage(run.id, { total_tokens: r.tokens, num_turns: r.turns });
    finishRun(run.id, r.status);
  }

  // Issue B finishes later, so it must sort ahead of A under recent-first ordering.
  await sleep(25);
  const b = createIssue({ project_id: project.id, title: 'Newer issue', status: 'done' });
  const runB = createRun(b.id, 'plan', 1);
  updateRunUsage(runB.id, { total_tokens: 10, num_turns: 1 });
  finishRun(runB.id, 'succeeded');

  // Issue C has no runs at all — must be excluded (history is runs only).
  createIssue({ project_id: project.id, title: 'Never run', status: 'backlog' });

  // A second project's issue must not leak into a single-project query.
  const other = createProject({ name: 'Other', key: 'OT', repo_path: env.repoPath });
  const o = createIssue({ project_id: other.id, title: 'Other project', status: 'done' });
  const runO = createRun(o.id, 'plan', 1);
  finishRun(runO.id, 'succeeded');

  const all = listIssueHistory();
  assert.equal(all.length, 3, 'three issues have runs (A, B, O); C is excluded');
  assert.ok(!all.some((r) => r.title === 'Never run'), 'issue without runs is excluded');

  const rowA = all.find((r) => r.issue_id === a.id)!;
  assert.equal(rowA.run_count, 4);
  assert.equal(rowA.attempts, 2, 'MAX attempt across runs');
  assert.equal(rowA.total_tokens, 650, 'SUM total_tokens (100+200+300+50)');
  assert.equal(rowA.num_turns, 10, 'SUM num_turns (2+3+4+1)');
  assert.equal(rowA.last_status, 'succeeded', 'latest run status');
  assert.equal(rowA.last_phase, 'qa', 'latest run phase');
  assert.equal(rowA.project_key, 'HI');
  assert.ok(rowA.started_at && rowA.ended_at, 'aggregated start/end timestamps present');

  // Recent-first: B (finished after A) precedes A; the cross-project O sits behind both.
  const scoped = listIssueHistory(project.id);
  assert.deepEqual(
    scoped.map((r) => r.issue_id),
    [b.id, a.id],
    'project query returns only its issues, most-recently-active first',
  );
});

test('listIssueHistory includes never-run cancelled issues but still excludes never-run open ones', () => {
  const project = createProject({ name: 'Cancelled', key: 'CX', repo_path: env.repoPath });

  // Cancelled with no runs at all — this is the only UI entry point for it, so it must appear.
  const c = createIssue({ project_id: project.id, title: 'Cancelled no run', status: 'cancelled' });
  // A never-run open issue must remain excluded so History is not flooded with backlog/todo.
  createIssue({ project_id: project.id, title: 'Backlog no run', status: 'backlog' });

  const rows = listIssueHistory(project.id);
  assert.equal(rows.length, 1, 'only the cancelled-never-run issue is listed');

  const rowC = rows.find((r) => r.issue_id === c.id)!;
  assert.ok(rowC, 'never-run cancelled issue is listed');
  assert.equal(rowC.run_count, 0, 'no runs aggregated');
  assert.equal(rowC.total_tokens, 0);
  assert.equal(rowC.attempts, 0);
  assert.equal(rowC.last_status, null, 'no latest-run status for a never-run issue');
  assert.equal(rowC.last_phase, null);
  assert.equal(rowC.started_at, null);
  assert.equal(rowC.ended_at, null);

  assert.ok(!rows.some((r) => r.title === 'Backlog no run'), 'never-run open issue stays excluded');
});
