import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { branchExists } = await import('../src/server/workspace/git');
const { issueRoutes } = await import('../src/server/http/routes/issues');

test.after(() => env.cleanup());

async function createReviewedIssue(key: string) {
  const project = createProject({ name: `Lifecycle ${key}`, key, repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: `Lifecycle ${key}`,
    status: 'todo',
    mode: 'auto',
  });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: `${key}.txt`, fileContent: `${key}\n` }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const ready = getIssue(issue.id)!;
  assert.equal(ready.status, 'review');
  assert.ok(ready.branch_name);
  assert.ok(ready.worktree_path);
  assert.equal(await branchExists(env.repoPath, ready.branch_name!), true);
  assert.equal(fs.existsSync(ready.worktree_path!), true);
  return ready;
}

test('approve merges and removes story branch/worktree pointers', async () => {
  const issue = await createReviewedIssue('AP');

  const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; reason?: string };
  assert.equal(body.ok, true, body.reason);

  const done = getIssue(issue.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.branch_name, null);
  assert.equal(done.worktree_path, null);
  assert.equal(fs.existsSync(issue.worktree_path!), false);
  assert.equal(await branchExists(env.repoPath, issue.branch_name!), false);
});

test('cancel abandons and removes unmerged story branch/worktree', async () => {
  const issue = await createReviewedIssue('CA');

  const res = await issueRoutes.request(`/${issue.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  assert.equal(res.status, 200);

  const cancelled = getIssue(issue.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.branch_name, null);
  assert.equal(cancelled.worktree_path, null);
  assert.equal(fs.existsSync(issue.worktree_path!), false);
  assert.equal(await branchExists(env.repoPath, issue.branch_name!), false);
});

test('delete removes story branch/worktree before deleting the row', async () => {
  const issue = await createReviewedIssue('DL');

  const res = await issueRoutes.request(`/${issue.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);

  assert.equal(getIssue(issue.id), null);
  assert.equal(fs.existsSync(issue.worktree_path!), false);
  assert.equal(await branchExists(env.repoPath, issue.branch_name!), false);
});
