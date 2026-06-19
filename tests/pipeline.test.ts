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

  // Four run rows (plan, implement, qa, delivery), all succeeded.
  const runs = listRuns(issue.id);
  assert.equal(runs.length, 4);
  assert.deepEqual(
    runs.map((r) => r.phase).sort(),
    ['delivery', 'implement', 'plan', 'qa'],
  );
  assert.ok(runs.every((r) => r.status === 'succeeded'));

  // The delivery phase persisted a user-facing summary for the review screen (§SYM-22).
  const delivery = runs.find((r) => r.phase === 'delivery');
  assert.match(delivery?.report ?? '', /## What's new/);

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
    assert.equal(inputs.length, 4, 'plan, implement, qa, delivery each ran once');
    assert.equal(inputs[1]!.maxTurns, 7, 'implement uses its per-phase cap');
    assert.equal(inputs[0]!.maxTurns, getConfig().max_turns, 'plan falls back to the engine default');
    assert.equal(inputs[2]!.maxTurns, getConfig().max_turns, 'qa falls back to the engine default');
    assert.equal(inputs[3]!.maxTurns, getConfig().max_turns, 'delivery falls back to the engine default');
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
  assert.equal(inputs.length, 4, 'plan, implement, qa, delivery each ran once');
  assert.deepEqual(inputs.map((input) => input.permissionMode), ['acceptEdits', 'acceptEdits', 'acceptEdits', 'acceptEdits']);
  // delivery has no per-phase cap configured, so it falls back to the engine default.
  assert.deepEqual(inputs.map((input) => input.maxTurns), [11, 22, 33, getConfig().max_turns]);
  assert.match(inputs[0]!.prompt, /Project plan prompt marker/);
  assert.match(inputs[1]!.prompt, /Project implement prompt marker/);
  assert.match(inputs[2]!.prompt, /Project QA prompt marker/);
  assert.match(inputs[3]!.prompt, /\*\*delivery lead\*\*/);
});

test('disableWorkflows defaults to true for every phase (orchestrator stays sole scheduler, SYM-41)', async () => {
  const project = createProject({ name: 'WF Default', key: 'WFD', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Default off', status: 'todo', mode: 'auto' });

  const inputs: AgentRunInput[] = [];
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config: getConfig(),
  });

  assert.equal(result.ok, true);
  assert.equal(inputs.length, 4, 'plan, implement, qa, delivery each ran once');
  assert.ok(inputs.every((i) => i.disableWorkflows === true), 'every phase disables the Workflow tool by default');
});

test('a project that enables the Workflow tool flips disableWorkflows to false across phases (SYM-41)', async () => {
  const project = createProject({
    name: 'WF Enabled',
    key: 'WFE',
    repo_path: env.repoPath,
    config: { agent: { enable_workflow_tool: true } },
  });
  const issue = createIssue({ project_id: project.id, title: 'Opt in', status: 'todo', mode: 'auto' });

  const inputs: AgentRunInput[] = [];
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config: getConfig(),
  });

  assert.equal(result.ok, true);
  assert.equal(inputs.length, 4);
  assert.ok(inputs.every((i) => i.disableWorkflows === false), 'the project override reaches every phase');
});

test('autonomous done path runs a merge phase to push the branch (SYM-16)', async () => {
  const project = createProject({ name: 'Auto Merge', key: 'AM', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Lands on the remote',
    status: 'todo',
    mode: 'auto',
    require_review: false, // no review gate → autonomous done path → merge phase runs
  });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', merge: 'pass' }),
    config: getConfig(),
  });

  // The issue reaches 'done' only after the merge agent landed it.
  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'done');
  assert.equal(getIssue(issue.id)!.status, 'done');

  // Five run rows now: plan, implement, qa, delivery, merge — all succeeded.
  const runs = listRuns(issue.id);
  assert.equal(runs.length, 5);
  assert.deepEqual(
    runs.map((r) => r.phase).sort(),
    ['delivery', 'implement', 'merge', 'plan', 'qa'],
  );
  const merge = runs.find((r) => r.phase === 'merge');
  assert.ok(merge && merge.status === 'succeeded', 'expected a succeeded merge run');
});

test('a merge FAIL leaves the issue in_progress for retry (SYM-16)', async () => {
  const project = createProject({ name: 'Merge Fail', key: 'MF', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Push will fail',
    status: 'todo',
    mode: 'auto',
    require_review: false,
  });

  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', merge: 'fail' }),
    config: getConfig(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase, 'merge');
  assert.equal(getIssue(issue.id)!.status, 'in_progress');
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
