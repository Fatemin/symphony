import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { listEvents } = await import('../src/server/repo/events');
const { listRuns } = await import('../src/server/repo/runs');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');

test.after(() => env.cleanup());

test('verification command failure blocks review and exposes stdout/stderr for retry', async () => {
  const project = createProject({
    name: 'Verification Retry',
    key: 'VR',
    repo_path: env.repoPath,
    config: {
      verification: {
        commands: [
          {
            command: `node -e "console.log('verify out'); console.error('verify err'); process.exit(1)"`,
            on_failure: 'retry',
          },
        ],
      },
    },
  });
  const issue = createIssue({ project_id: project.id, title: 'Must pass tests', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass' }),
    config: getConfig(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase, 'qa');
  assert.match(result.error ?? '', /verify out/);
  assert.match(result.error ?? '', /verify err/);
  assert.equal(getIssue(issue.id)!.status, 'in_progress');
  assert.equal(getIssue(issue.id)!.mode, 'auto');
  assert.ok(listEvents({ issue_id: issue.id }).some((event) => event.kind === 'verification.failed'));
});

test('verification can park an issue to manual instead of retrying', async () => {
  const project = createProject({
    name: 'Verification Park',
    key: 'VP',
    repo_path: env.repoPath,
    config: {
      verification: {
        commands: [{ command: `node -e "process.exit(2)"`, on_failure: 'park' }],
      },
    },
  });
  const issue = createIssue({ project_id: project.id, title: 'Park on test failure', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass' }),
    config: getConfig(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.park, true);
  assert.equal(getIssue(issue.id)!.status, 'in_progress');
  assert.equal(getIssue(issue.id)!.mode, 'manual');
});

test('when verification is configured, self-QA fail is auxiliary and objective commands decide', async () => {
  const project = createProject({
    name: 'Objective Gate',
    key: 'OG',
    repo_path: env.repoPath,
    config: {
      verification: {
        commands: [{ command: `node -e "process.exit(0)"` }],
      },
    },
  });
  const issue = createIssue({ project_id: project.id, title: 'Objective pass', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'fail' }),
    config: getConfig(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'review');
  assert.equal(getIssue(issue.id)!.status, 'review');
  assert.equal(listRuns(issue.id).find((run) => run.phase === 'qa')!.status, 'failed');
  assert.ok(
    listEvents({ issue_id: issue.id }).some((event) => event.kind === 'phase.end' && String(event.message).includes('QA FAIL')),
    'self-QA fail should remain visible as an auxiliary signal',
  );
});

test('verification success still fails if commands leave the worktree dirty', async () => {
  const project = createProject({
    name: 'Dirty Verify',
    key: 'DV',
    repo_path: env.repoPath,
    config: {
      verification: {
        commands: [{ command: `node -e "require('fs').appendFileSync('AGENT_OUTPUT.md', 'dirty\\n')"` }],
      },
    },
  });
  const issue = createIssue({ project_id: project.id, title: 'Dirty command', status: 'todo', mode: 'auto' });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass' }),
    config: getConfig(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase, 'qa');
  assert.match(result.error ?? '', /git status --porcelain/);
  assert.match(result.error ?? '', /AGENT_OUTPUT\.md/);
  assert.equal(getIssue(issue.id)!.status, 'in_progress');
});
