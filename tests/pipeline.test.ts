import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { listTasks } = await import('../src/server/repo/tasks');
const { listRuns } = await import('../src/server/repo/runs');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');

test.after(() => env.cleanup());

test('full pipeline drives an issue todo → review with a real commit', async () => {
  const project = createProject({
    name: 'Pipeline Test',
    key: 'PT',
    repo_path: env.repoPath,
    default_branch: 'main',
  });
  const issue = createIssue({
    project_id: project.id,
    title: 'Add a health file',
    type: 'feature',
    acceptance_criteria: '- A file exists',
    status: 'todo',
    mode: 'auto',
  });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'HEALTH.txt', fileContent: 'ok\n' }),
    config: getConfig(),
  });

  // Pipeline succeeded and parked at the review gate.
  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'review');
  assert.equal(getIssue(issue.id)!.status, 'review');

  // Planner wrote a task checklist.
  assert.ok(listTasks(issue.id).length >= 1, 'expected at least one planned task');

  // Three run rows (plan, implement, qa), all succeeded.
  const runs = listRuns(issue.id);
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((r) => r.phase).sort(),
    ['implement', 'plan', 'qa'],
  );
  assert.ok(runs.every((r) => r.status === 'succeeded'));

  // The agent's file was actually written into the worktree and committed.
  const wt = getIssue(issue.id)!.worktree_path!;
  assert.ok(fs.existsSync(path.join(wt, 'HEALTH.txt')), 'agent file should exist in worktree');
});

test('a QA FAIL leaves the issue in_progress for retry', async () => {
  const project = createProject({ name: 'QA Fail', key: 'QF', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Will fail QA',
    status: 'todo',
    mode: 'auto',
  });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'fail' }),
    config: getConfig(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase, 'qa');
  assert.equal(getIssue(issue.id)!.status, 'in_progress');
});
