import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { getProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { issueRoutes } = await import('../src/server/http/routes/issues');

test.after(() => env.cleanup());

const g = (...args: string[]) => execFileSync('git', args, { cwd: env.repoPath, stdio: 'pipe' }).toString().trim();

test('default approval still performs a local direct merge and marks done', async () => {
  const project = createProject({ name: 'Direct Merge', key: 'DM', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Default promotion', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'direct.txt', fileContent: 'direct\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const review = getIssue(issue.id)!;
  const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; commit?: string; reason?: string };
  assert.equal(body.ok, true, body.reason);
  assert.equal(getIssue(issue.id)!.status, 'done');
  assert.match(g('log', '--oneline', '-1'), new RegExp(`Merge ${review.key}`));
});

test('approval can create a selected target branch and set it as the project default', async () => {
  const project = createProject({ name: 'Target Branch', key: 'TB', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Merge to release', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'release.txt', fileContent: 'release\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const res = await issueRoutes.request(`/${issue.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_branch: 'release/testing', create_branch: true, set_default_branch: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; reason?: string };
  assert.equal(body.ok, true, body.reason);

  assert.equal(getIssue(issue.id)!.status, 'done');
  assert.equal(getIssue(issue.id)!.base_branch, 'release/testing');
  assert.equal(getProject(project.id)!.default_branch, 'release/testing');
  assert.equal(g('show', 'release/testing:release.txt'), 'release');
});

test('approval rejects a missing target branch unless creation is requested', async () => {
  const project = createProject({ name: 'Missing Branch', key: 'MB', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Reject missing branch', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'missing-target.txt', fileContent: 'missing\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const res = await issueRoutes.request(`/${issue.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_branch: 'does-not-exist' }),
  });
  assert.equal(res.status, 409);
  assert.equal(getIssue(issue.id)!.status, 'review');
  assert.throws(() => g('rev-parse', '--verify', 'does-not-exist'));
});

test('pull-request promotion pushes the branch and opens a PR without merging', async () => {
  const remote = path.join(env.root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  g('remote', 'add', 'origin', remote);
  g('push', '-u', 'origin', 'main');
  const remoteMain = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim();

  const ghBin = path.join(env.root, 'bin');
  const ghLog = path.join(env.root, 'gh.log');
  fs.mkdirSync(ghBin, { recursive: true });
  fs.writeFileSync(
    path.join(ghBin, 'gh'),
    [
      '#!/bin/sh',
      'echo "$@" >> "$GH_LOG"',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "https://github.com/example/repo/pull/42"',
      '  exit 0',
      'fi',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      '  echo "https://github.com/example/repo/pull/42"',
      '  exit 0',
      'fi',
      'echo "unexpected gh call: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${ghBin}:${oldPath}`;
  process.env.GH_LOG = ghLog;
  try {
    const project = createProject({
      name: 'Pull Request',
      key: 'PR',
      repo_path: env.repoPath,
      config: {
        verification: { commands: [{ command: `node -e "process.exit(0)"` }] },
        promotion: { mode: 'pull-request', remote: 'origin', base_branch: 'main' },
      },
    });
    const issue = createIssue({ project_id: project.id, title: 'PR promotion', status: 'todo', mode: 'auto' });

    const result = await runIssuePipeline(issue.id, {
      runner: makeFakeRunner({ qa: 'pass', fileName: 'pr.txt', fileContent: 'pr\n' }),
      config: getConfig(),
    });
    assert.equal(result.ok, true);
    const review = getIssue(issue.id)!;
    assert.equal(review.status, 'review');

    const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; pr_url?: string; merged?: boolean; reason?: string };
    assert.equal(body.ok, true, body.reason);
    assert.equal(body.pr_url, 'https://github.com/example/repo/pull/42');
    assert.equal(body.merged, false);

    const pushed = execFileSync('git', ['ls-remote', '--heads', 'origin', review.branch_name!], {
      cwd: env.repoPath,
      stdio: 'pipe',
    }).toString();
    assert.match(pushed, new RegExp(review.branch_name!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim(), remoteMain);
    assert.equal(getIssue(issue.id)!.status, 'review');
    assert.match(fs.readFileSync(ghLog, 'utf8'), /pr create/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.GH_LOG;
  }
});
