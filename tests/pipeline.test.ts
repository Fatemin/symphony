import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunInput } from '../src/server/agent/types';
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

  // Cache traffic is recorded per run — it's the real cost driver; total_tokens alone
  // understates throughput by an order of magnitude on long sessions.
  assert.ok(
    runs.every((r) => r.cache_read_tokens === 700 && r.cache_creation_tokens === 70),
    'cache token columns should be persisted from agent usage events',
  );

  // The agent's file was actually written into the worktree and committed.
  const wt = getIssue(issue.id)!.worktree_path!;
  assert.ok(fs.existsSync(path.join(wt, 'HEALTH.txt')), 'agent file should exist in worktree');
});

test('WORKFLOW.md per-phase max_turns overrides only the named phase', async () => {
  const wf = path.join(env.repoPath, 'WORKFLOW.md');
  fs.writeFileSync(wf, ['---', 'agent:', '  max_turns:', '    implement: 7', '---', ''].join('\n'));
  try {
    const project = createProject({ name: 'Turn Caps', key: 'TC', repo_path: env.repoPath });
    const issue = createIssue({
      project_id: project.id,
      title: 'Per-phase caps',
      status: 'todo',
      mode: 'auto',
    });

    const inputs: AgentRunInput[] = [];
    const result = await runIssuePipeline(issue.id, {
      runner: makeFakeRunner({ qa: 'pass', inputs }),
      config: getConfig(),
    });

    assert.equal(result.ok, true);
    assert.equal(inputs.length, 3, 'plan, implement, qa each ran once');
    assert.equal(inputs[1]!.maxTurns, 7, 'implement uses its per-phase cap');
    assert.equal(inputs[0]!.maxTurns, getConfig().max_turns, 'plan falls back to the engine default');
    assert.equal(inputs[2]!.maxTurns, getConfig().max_turns, 'qa falls back to the engine default');
  } finally {
    fs.unlinkSync(wf); // env.repoPath is shared by the other tests in this file
  }
});

test('project agent config affects CLI input and phase prompts', async () => {
  const project = createProject({
    name: 'Project Agent Config',
    key: 'PAC',
    repo_path: env.repoPath,
    config: {
      agent: {
        permission_mode: 'acceptEdits',
        max_turns_by_phase: { plan: 11, implement: 22, qa: 33 },
      },
      prompts: {
        plan: 'Project plan prompt marker',
        implement: 'Project implement prompt marker',
        qa: 'Project QA prompt marker',
      },
    },
  });
  const issue = createIssue({
    project_id: project.id,
    title: 'Use project agent config',
    status: 'todo',
    mode: 'auto',
  });

  const inputs: AgentRunInput[] = [];
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config: getConfig(),
  });

  assert.equal(result.ok, true);
  assert.equal(inputs.length, 3, 'plan, implement, qa each ran once');
  assert.deepEqual(inputs.map((input) => input.permissionMode), ['acceptEdits', 'acceptEdits', 'acceptEdits']);
  assert.deepEqual(inputs.map((input) => input.maxTurns), [11, 22, 33]);
  assert.match(inputs[0]!.prompt, /Project plan prompt marker/);
  assert.match(inputs[1]!.prompt, /Project implement prompt marker/);
  assert.match(inputs[2]!.prompt, /Project QA prompt marker/);
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
