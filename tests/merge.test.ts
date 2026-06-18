import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';

const env = setupEnv();

const { mergeAgentBranch } = await import('../src/server/workspace/worktree');

test.after(() => env.cleanup());

const g = (...args: string[]) =>
  execFileSync('git', args, { cwd: env.repoPath, stdio: 'pipe' }).toString();
const write = (name: string, content: string) =>
  fs.writeFileSync(path.join(env.repoPath, name), content);

/** Create an agent branch off main containing one committed change, then return to main. */
function makeBranch(branch: string, file: string, content: string): void {
  g('checkout', '-b', branch, 'main');
  write(file, content);
  g('add', '-A');
  g('commit', '-m', `agent change on ${branch}`);
  g('checkout', 'main');
}

test('merge succeeds with unrelated uncommitted changes in the main repo', async () => {
  makeBranch('agent/t1', 'feature.txt', 'new feature\n');
  write('README.md', '# scratch repo\nlocal uncommitted edit\n'); // dirty, NOT touched by branch

  const result = await mergeAgentBranch(env.repoPath, 'main', 'agent/t1', 'merge t1');
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.commit, 'expected a merge commit hash');

  // The branch change landed and the local edit survived untouched.
  assert.ok(fs.existsSync(path.join(env.repoPath, 'feature.txt')));
  assert.match(fs.readFileSync(path.join(env.repoPath, 'README.md'), 'utf8'), /local uncommitted edit/);
  assert.match(g('status', '--porcelain'), /README\.md/);
});

test('merge is refused when uncommitted changes overlap the branch diff', async () => {
  g('checkout', '--', 'README.md'); // start clean
  makeBranch('agent/t2', 'README.md', '# rewritten by agent\n');
  write('README.md', '# scratch repo\nconflicting local edit\n'); // dirty AND touched by branch

  const result = await mergeAgentBranch(env.repoPath, 'main', 'agent/t2', 'merge t2');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /overwritten|local changes/i);

  // The local edit is intact — git refused before touching anything.
  assert.match(fs.readFileSync(path.join(env.repoPath, 'README.md'), 'utf8'), /conflicting local edit/);
});

test('merge uses a temporary base worktree when the main repo is on another dirty branch', async () => {
  g('checkout', '--', 'README.md');
  makeBranch('agent/t3', 'feature3.txt', 'three\n');
  g('checkout', '-b', 'elsewhere');
  write('README.md', '# scratch repo\ndirty on another branch\n');

  const result = await mergeAgentBranch(env.repoPath, 'main', 'agent/t3', 'merge t3');
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.commit, 'expected a merge commit hash');
  assert.equal(g('branch', '--show-current').trim(), 'elsewhere');
  assert.match(fs.readFileSync(path.join(env.repoPath, 'README.md'), 'utf8'), /dirty on another branch/);
  assert.equal(g('show', 'main:feature3.txt'), 'three\n');

  g('checkout', '--', 'README.md');
  g('checkout', 'main');
});

test('merge resolver handles content conflicts in an integration worktree', async () => {
  write('conflict.txt', 'title=base\n');
  g('add', '-A');
  g('commit', '-m', 'add conflict fixture');

  g('checkout', '-b', 'agent/t4', 'main');
  write('conflict.txt', 'title=agent story\n');
  g('add', '-A');
  g('commit', '-m', 'agent edits conflict fixture');
  g('checkout', 'main');
  write('conflict.txt', 'title=main sidebar\n');
  g('add', '-A');
  g('commit', '-m', 'main edits conflict fixture');

  const result = await mergeAgentBranch(env.repoPath, 'main', 'agent/t4', 'merge t4', {
    resolver: async ({ checkoutPath, conflictedFiles, mergeOutput }) => {
      assert.deepEqual(conflictedFiles, ['conflict.txt']);
      assert.match(mergeOutput, /CONFLICT/);
      assert.match(fs.readFileSync(path.join(checkoutPath, 'conflict.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
      fs.writeFileSync(path.join(checkoutPath, 'conflict.txt'), 'title=main sidebar + agent story\n');
      return { ok: true, report: 'combined both edits' };
    },
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.resolved_conflicts, true);
  assert.deepEqual(result.conflicted_files, ['conflict.txt']);
  assert.equal(result.report, 'combined both edits');
  assert.equal(g('show', 'main:conflict.txt'), 'title=main sidebar + agent story\n');
});
