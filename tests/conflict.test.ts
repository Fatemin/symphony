import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';
import type { MergeConflictResolver } from '../src/server/workspace/worktree';

// SYM-29: offline coverage for the git-conflict marker plumbing — divergence detection, the
// agent-backed reconcileAndPushBase merge mechanics (with an INJECTED stub resolver so no CLI runs),
// the repo set/clear JSON round-trip, and the route-level marker lifecycle for a CLEAN reconcile.
// The real agent-driven conflict resolution path (runClaudeCode) is verified manually, never here.
const env = setupEnv();

const { pushBaseBranch, reconcileAndPushBase } = await import('../src/server/workspace/worktree');
const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue, setMergeConflict, clearMergeConflict } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { issueRoutes } = await import('../src/server/http/routes/issues');
const { listEvents } = await import('../src/server/repo/events');

test.after(() => env.cleanup());

const g = (...args: string[]) => execFileSync('git', args, { cwd: env.repoPath, stdio: 'pipe' }).toString().trim();
const remoteSha = (remote: string, ref = 'refs/heads/main') =>
  execFileSync('git', ['rev-parse', ref], { cwd: remote, stdio: 'pipe' }).toString().trim();

/** Init a bare remote, register it under `name`, and seed it with the current local main. */
function seedRemote(dir: string, name: string): string {
  const remote = path.join(env.root, dir);
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  g('remote', 'add', name, remote);
  g('push', name, 'main');
  return remote;
}

/** Advance a remote's main out-of-band via a throwaway clone (so a later local push is non-ff). */
function advanceRemote(remote: string, file: string, content: string): void {
  const clone = path.join(env.root, `clone-${path.basename(remote)}`);
  execFileSync('git', ['clone', remote, clone], { stdio: 'pipe' });
  const c = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' });
  c('config', 'user.email', 'remote@example.com');
  c('config', 'user.name', 'Remote User');
  fs.writeFileSync(path.join(clone, file), content);
  c('add', '-A');
  c('commit', '-m', `remote advanced: ${file}`);
  c('push', 'origin', 'main');
}

/** Commit a change to local main, returning to a clean tree on main. */
function commitOnMain(file: string, content: string): void {
  fs.writeFileSync(path.join(env.repoPath, file), content);
  g('add', '-A');
  g('commit', '-m', `local change: ${file}`);
}

test('pushBaseBranch flags diverged when the remote base has commits not in local', async () => {
  const remote = seedRemote('cf-diverged.git', 'origin-div');
  advanceRemote(remote, 'div-remote.txt', 'remote-only\n'); // remote moves ahead of local main

  const result = await pushBaseBranch(env.repoPath, 'origin-div', 'main');
  assert.equal(result.ok, false);
  assert.equal(result.pushed, false);
  assert.equal(result.diverged, true, 'a non-ff remote must be flagged diverged, not a generic failure');
  assert.match(result.reason ?? '', /not in local|diverged|has commits/);

  // It must NOT force-push: the remote keeps its out-of-band commit, untouched.
  assert.equal(remoteSha(remote), g('rev-parse', 'origin-div/main'));
});

test('reconcileAndPushBase merges a conflicting diverged remote via the injected resolver, then pushes', async () => {
  commitOnMain('rc-shared.txt', 'base\n'); // common ancestor on local main
  const remote = seedRemote('cf-reconcile.git', 'origin-rc');
  advanceRemote(remote, 'rc-shared.txt', 'remote edit\n'); // remote edits the shared file…
  commitOnMain('rc-shared.txt', 'local edit\n'); // …and so does local — a real content conflict

  let resolverCalls = 0;
  const resolver: MergeConflictResolver = async ({ checkoutPath, conflictedFiles, mergeOutput }) => {
    resolverCalls += 1;
    assert.deepEqual(conflictedFiles, ['rc-shared.txt']);
    assert.match(mergeOutput, /CONFLICT/);
    for (const file of conflictedFiles) fs.writeFileSync(path.join(checkoutPath, file), 'reconciled\n');
    return { ok: true, report: 'combined remote + local edits' };
  };

  const result = await reconcileAndPushBase(env.repoPath, 'origin-rc', 'main', 'reconcile rc', { resolver });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.pushed, true);
  assert.equal(resolverCalls, 1, 'a conflicting reconcile must invoke the resolver exactly once');

  // The reconciled content landed on local main and was pushed, so the remote now matches local.
  assert.equal(g('show', 'main:rc-shared.txt'), 'reconciled');
  assert.equal(remoteSha(remote), g('rev-parse', 'main'));
  // The private fetch ref is cleaned up, never left lying around.
  assert.equal(g('for-each-ref', '--format=%(refname)', 'refs/heads/symphony'), '');
});

test('reconcileAndPushBase merges a clean divergence without invoking the resolver', async () => {
  const remote = seedRemote('cf-clean.git', 'origin-clean');
  advanceRemote(remote, 'clean-remote.txt', 'remote-only\n'); // remote adds a file…
  commitOnMain('clean-local.txt', 'local-only\n'); // …local adds a different one — no conflict

  let resolverCalls = 0;
  const resolver: MergeConflictResolver = async () => {
    resolverCalls += 1;
    return { ok: false, reason: 'resolver should not run for a clean divergence' };
  };

  const result = await reconcileAndPushBase(env.repoPath, 'origin-clean', 'main', 'reconcile clean', { resolver });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.pushed, true);
  assert.equal(resolverCalls, 0, 'a non-conflicting reconcile merges silently — no agent/resolver');

  // Both sides landed and the push fast-forwarded the remote.
  assert.equal(g('show', 'main:clean-remote.txt'), 'remote-only');
  assert.equal(g('show', 'main:clean-local.txt'), 'local-only');
  assert.equal(remoteSha(remote), g('rev-parse', 'main'));
});

test('repo set/clear round-trips the merge_conflict JSON decoration', () => {
  const project = createProject({ name: 'Marker', key: 'MK', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Marker round-trip', status: 'review' });
  assert.equal(getIssue(issue.id)!.merge_conflict, null, 'a fresh issue carries no conflict marker');

  const info = {
    kind: 'push' as const,
    target_branch: 'main',
    remote: 'origin',
    reason: 'remote/main has commits not in local main',
    files: ['a.ts', 'b.ts'],
    detected_at: '2026-06-19T00:00:00.000Z',
  };
  setMergeConflict(issue.id, info);
  assert.deepEqual(getIssue(issue.id)!.merge_conflict, info, 'the marker round-trips through TEXT JSON intact');

  clearMergeConflict(issue.id);
  assert.equal(getIssue(issue.id)!.merge_conflict, null, 'clearing removes the decoration');
});

test('a diverged push sets the push marker (review), and resolve-conflict reconciles + clears it (done)', async () => {
  const remote = seedRemote('cf-route.git', 'origin-life');
  advanceRemote(remote, 'life-remote.txt', 'remote-only\n'); // remote diverges, non-conflicting with the story

  const project = createProject({
    name: 'Conflict Lifecycle',
    key: 'CL',
    repo_path: env.repoPath,
    config: { promotion: { mode: 'direct-merge', remote: 'origin-life' } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Resolve a diverged push', status: 'todo', mode: 'auto' });

  const built = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', fileName: 'life.txt', fileContent: 'life\n' }),
    config: getConfig(),
  });
  assert.equal(built.ok, true);
  assert.equal(getIssue(issue.id)!.status, 'review');

  // Approve: the local merge lands but the push is non-ff → marker {kind:'push'}, issue stays parked.
  const approveRes = await issueRoutes.request(`/${issue.id}/approve`, { method: 'POST' });
  assert.equal(approveRes.status, 409);
  const parked = getIssue(issue.id)!;
  assert.equal(parked.status, 'review');
  assert.ok(parked.merge_conflict, 'a diverged push must decorate the issue with a git-conflict marker');
  assert.equal(parked.merge_conflict!.kind, 'push');
  assert.equal(parked.merge_conflict!.target_branch, 'main');
  assert.ok(listEvents({ issue_id: issue.id }).some((e) => e.kind === 'conflict.detected'));

  // Resolve-conflict: re-merge (idempotent) + a CLEAN remote reconcile (no resolver/agent) → done.
  const resolveRes = await issueRoutes.request(`/${issue.id}/resolve-conflict`, { method: 'POST' });
  assert.equal(resolveRes.status, 200);
  const body = (await resolveRes.json()) as { ok: boolean; reason?: string; target_branch?: string };
  assert.equal(body.ok, true, body.reason);

  const done = getIssue(issue.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.merge_conflict, null, 'a resolved conflict clears the marker');
  assert.ok(listEvents({ issue_id: issue.id }).some((e) => e.kind === 'conflict.resolved'));

  // Both the story change and the remote's out-of-band commit are now on the pushed base.
  assert.equal(remoteSha(remote), g('rev-parse', 'main'));
  assert.equal(g('show', 'main:life.txt'), 'life');
  assert.equal(g('show', 'main:life-remote.txt'), 'remote-only');
});
