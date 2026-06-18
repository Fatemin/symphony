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

test('merge is refused when dirty and the base branch is not checked out', async () => {
  g('checkout', '--', 'README.md');
  makeBranch('agent/t3', 'feature3.txt', 'three\n');
  g('checkout', '-b', 'elsewhere');
  write('README.md', '# scratch repo\ndirty on another branch\n');

  const result = await mergeAgentBranch(env.repoPath, 'main', 'agent/t3', 'merge t3');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /not checked out/);

  g('checkout', '--', 'README.md');
  g('checkout', 'main');
});
