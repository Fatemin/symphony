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
const { listEvents } = await import('../src/server/repo/events');

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

test('pull-request promotion (auto_merge off) opens a PR and marks the issue done in one approve', async () => {
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
    const body = await res.json() as { ok: boolean; pr_url?: string; merged?: boolean; done?: boolean; reason?: string };
    assert.equal(body.ok, true, body.reason);
    assert.equal(body.pr_url, 'https://github.com/example/repo/pull/42');
    assert.equal(body.merged, false);
    // auto_merge is off, so opening the PR is the handoff/completion point — one approve reaches 'done'.
    assert.equal(body.done, true);

    const pushed = execFileSync('git', ['ls-remote', '--heads', 'origin', review.branch_name!], {
      cwd: env.repoPath,
      stdio: 'pipe',
    }).toString();
    assert.match(pushed, new RegExp(review.branch_name!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim(), remoteMain);
    const done = getIssue(issue.id)!;
    assert.equal(done.status, 'done');
    assert.equal(done.branch_name, null);
    assert.equal(done.worktree_path, null);
    assert.match(fs.readFileSync(ghLog, 'utf8'), /pr create/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.GH_LOG;
  }
});

test('pull-request promotion (auto_merge on) keeps the issue in review when the PR is not yet mergeable', async () => {
  const remote = path.join(env.root, 'remote-am.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  g('remote', 'add', 'origin-am', remote);
  g('push', '-u', 'origin-am', 'main');

  const ghBin = path.join(env.root, 'bin-am');
  const ghLog = path.join(env.root, 'gh-am.log');
  fs.mkdirSync(ghBin, { recursive: true });
  fs.writeFileSync(
    path.join(ghBin, 'gh'),
    [
      '#!/bin/sh',
      'echo "$@" >> "$GH_LOG"',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "https://github.com/example/repo/pull/77"',
      '  exit 0',
      'fi',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      // PR is blocked on a required review, so auto-merge never fires.
      '  echo \'{"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","statusCheckRollup":[]}\'',
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
      name: 'Auto Merge',
      key: 'AM',
      repo_path: env.repoPath,
      config: {
        verification: { commands: [{ command: `node -e "process.exit(0)"` }] },
        // check_timeout_ms:0 makes the auto-merge poll bail out immediately instead of waiting.
        promotion: { mode: 'pull-request', remote: 'origin-am', base_branch: 'main', auto_merge: true, check_timeout_ms: 0, check_poll_interval_ms: 0 },
      },
    });
    const issue = createIssue({ project_id: project.id, title: 'Auto-merge promotion', status: 'todo', mode: 'auto' });

    const result = await runIssuePipeline(issue.id, {
      runner: makeFakeRunner({ qa: 'pass', fileName: 'am.txt', fileContent: 'am\n' }),
      config: getConfig(),
    });
    assert.equal(result.ok, true);
    assert.equal(getIssue(issue.id)!.status, 'review');

    const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; merged?: boolean; done?: boolean; reason?: string };
    assert.equal(body.ok, true, body.reason);
    assert.equal(body.merged, false);
    assert.equal(body.done, false);

    // auto_merge is on but the PR isn't mergeable, so the issue stays parked and the branch is
    // retained so a re-approve can re-poll the PR until checks/reviews are satisfied.
    const after = getIssue(issue.id)!;
    assert.equal(after.status, 'review');
    assert.ok(after.branch_name, 'branch retained for a re-approve to re-poll the PR');
  } finally {
    process.env.PATH = oldPath;
    delete process.env.GH_LOG;
  }
});

test('direct-merge approval pushes the base to the configured remote so GitHub Actions can fire', async () => {
  const remote = path.join(env.root, 'remote-push.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  g('remote', 'add', 'origin-push', remote);
  g('push', 'origin-push', 'main'); // seed the remote base with the current local main

  const project = createProject({
    name: 'Push On Approve',
    key: 'PUSH',
    repo_path: env.repoPath,
    config: { promotion: { mode: 'direct-merge', remote: 'origin-push' } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Push to remote', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'push.txt', fileContent: 'push\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const review = getIssue(issue.id)!;
  const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; pushed?: boolean; remote?: string; reason?: string };
  assert.equal(body.ok, true, body.reason);
  assert.equal(body.pushed, true);
  assert.equal(body.remote, 'origin-push');
  assert.equal(getIssue(issue.id)!.status, 'done');

  // The local merge commit reached the remote, so the remote base now matches local main.
  const localMain = g('rev-parse', 'main');
  const remoteMain = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim();
  assert.equal(remoteMain, localMain);
  assert.match(g('log', '--oneline', '-1'), new RegExp(`Merge ${review.key}`));
});

test('direct-merge approval fails loudly when the remote base has diverged (non-ff push)', async () => {
  const remote = path.join(env.root, 'remote-nonff.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  g('remote', 'add', 'origin-nonff', remote);
  g('push', 'origin-nonff', 'main');

  // Advance the remote base out-of-band via a throwaway clone so the approve's push is non-ff.
  const clone = path.join(env.root, 'nonff-clone');
  execFileSync('git', ['clone', remote, clone], { stdio: 'pipe' });
  const c = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' }).toString().trim();
  c('config', 'user.email', 'remote@example.com');
  c('config', 'user.name', 'Remote User');
  fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote-only\n');
  c('add', '-A');
  c('commit', '-m', 'remote advanced out-of-band');
  c('push', 'origin', 'main');

  const project = createProject({
    name: 'Non FF',
    key: 'NFF',
    repo_path: env.repoPath,
    config: { promotion: { mode: 'direct-merge', remote: 'origin-nonff' } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Non-ff push', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'nonff.txt', fileContent: 'nonff\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const review = getIssue(issue.id)!;
  const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 409);
  const body = await res.json() as { ok: boolean; reason?: string };
  assert.equal(body.ok, false);
  assert.match(body.reason ?? '', /not in local|diverged|has commits/);

  // The push failed, so the issue stays parked for a re-approve rather than silently marked done.
  assert.equal(getIssue(issue.id)!.status, 'review');
  assert.ok(listEvents({ issue_id: issue.id }).some((e) => e.kind === 'approve.failed'));

  // The local merge already landed — local main carries it even though the remote rejected the push.
  assert.match(g('log', '--oneline', '-1'), new RegExp(`Merge ${review.key}`));
  const remoteMain = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim();
  assert.notEqual(remoteMain, g('rev-parse', 'main'));
});

test('direct-merge approval stays local-only when promotion.push is disabled even with a remote', async () => {
  const remote = path.join(env.root, 'remote-optout.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  g('remote', 'add', 'origin-optout', remote);
  g('push', 'origin-optout', 'main');
  const remoteMainBefore = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim();

  const project = createProject({
    name: 'Opt Out',
    key: 'OPT',
    repo_path: env.repoPath,
    config: { promotion: { mode: 'direct-merge', remote: 'origin-optout', push: false } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Local only', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'optout.txt', fileContent: 'optout\n' }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);

  const res = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; pushed?: boolean; reason?: string };
  assert.equal(body.ok, true, body.reason);
  assert.equal(body.pushed, false);
  assert.equal(getIssue(issue.id)!.status, 'done');

  // push disabled → the remote base must not move even though a remote is configured.
  const remoteMainAfter = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, stdio: 'pipe' }).toString().trim();
  assert.equal(remoteMainAfter, remoteMainBefore);
});
