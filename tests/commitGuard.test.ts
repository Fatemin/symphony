import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { installCommitGuardHook } = await import('../src/server/workspace/worktree');

test.after(() => env.cleanup());

test('commit guard blocks configured scratch files before Symphony commits them', async () => {
  const project = createProject({
    name: 'Guard Scratch',
    key: 'GS',
    repo_path: env.repoPath,
    config: { commit_guard: { enabled: true } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Do not commit temp files', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'notes_TEMP.md', fileContent: 'scratch\n' }),
    config: getConfig(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase, 'implement');
  assert.match(result.error ?? '', /notes_TEMP\.md/);
  assert.equal(getIssue(issue.id)!.status, 'in_progress');
});

test('worktree pre-commit hook blocks manual git add -A commits', async () => {
  const project = createProject({
    name: 'Guard Hook',
    key: 'GH',
    repo_path: env.repoPath,
    config: { commit_guard: { enabled: true } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Install hook', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'guarded.txt', fileContent: 'ok\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const worktree = getIssue(issue.id)!.worktree_path!;
  fs.writeFileSync(path.join(worktree, 'manual.txt'), 'manual\n');
  execFileSync('git', ['add', '-A'], { cwd: worktree, stdio: 'pipe' });

  assert.throws(
    () => execFileSync('git', ['commit', '-m', 'manual commit'], { cwd: worktree, stdio: 'pipe' }),
    /Symphony commit guard|Command failed/,
  );

  await installCommitGuardHook(worktree, {
    enabled: false,
    blocked_untracked_globs: ['*_TEMP.*'],
    override_limits: false,
  });
  execFileSync('git', ['commit', '-m', 'manual commit after disabling guard'], { cwd: worktree, stdio: 'pipe' });
});
