import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';
import type { AgentRunInput, AgentRunner } from '../src/server/agent/types';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { listRecentNotes } = await import('../src/server/repo/notes');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');

test.after(() => env.cleanup());

test('retries reuse plan context, rerun implement after QA verdict fail, and resume QA', async () => {
  const project = createProject({ name: 'Memory', key: 'ME', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Needs two attempts',
    status: 'todo',
    mode: 'auto',
  });

  // Attempt 1: QA fails, leaving a failed run row with the verdict as its error.
  const first = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'fail' }),
    config: getConfig(),
  });
  assert.equal(first.ok, false);
  assert.equal(first.failedPhase, 'qa');

  // Attempt 2: passes; capture every agent input.
  const inputs: AgentRunInput[] = [];
  const second = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config: getConfig(),
    attempt: 2,
  });
  assert.equal(second.ok, true);
  assert.equal(inputs.length, 2, 'plan should be skipped, implement and QA should run');

  const [implement, qa] = inputs;
  // (1) The last failure (phase + QA verdict) is threaded into every phase prompt.
  for (const input of inputs) {
    assert.match(input.prompt, /retry attempt 2/);
    assert.match(input.prompt, /\*\*qa\*\* phase/);
    assert.match(input.prompt, /missing behavior/);
  }
  // (2) Implement receives the planner's persisted repository map instead of rediscovering it.
  assert.match(implement!.prompt, /Planning context - key files/);
  assert.match(implement!.prompt, /src\/example\.ts/);
  assert.match(implement!.prompt, /avoid rediscovering the route map/);
  // (3) A QA verdict failure requires a fresh implement pass, while QA resumes its failed session.
  assert.equal(implement!.resumeSessionId, undefined);
  assert.equal(qa!.resumeSessionId, 'fake-qa');
  // (4) QA receives the new implement phase's report.
  assert.match(qa!.prompt, /<implementation-report>/);
  assert.match(qa!.prompt, /Implemented and wrote the file/);
  // First-attempt phases must not resume anything.
  assert.equal(
    inputs.some((i) => i.prompt.includes('retry attempt 1')),
    false,
  );
});

test('restart after implement cancellation skips completed plan and resumes implement', async () => {
  const project = createProject({ name: 'Restart', key: 'RT', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Interrupted implement',
    status: 'todo',
    mode: 'auto',
  });

  const calls = { plan: 0, implement: 0, qa: 0 };
  const first = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ failPhase: 'implement', calls }),
    config: getConfig(),
  });
  assert.equal(first.ok, false);
  assert.equal(first.failedPhase, 'implement');
  assert.deepEqual(calls, { plan: 1, implement: 1, qa: 0 });

  const inputs: AgentRunInput[] = [];
  const second = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', calls, inputs }),
    config: getConfig(),
  });
  assert.equal(second.ok, true);
  assert.deepEqual(calls, { plan: 1, implement: 2, qa: 1 }, 'plan should not rerun after restart');
  assert.equal(inputs[0]!.resumeSessionId, 'fake-implement');
  assert.match(inputs[0]!.prompt, /\*\*implementing engineer\*\*/);
});

test('a completed issue leaves a learning note that later issues receive', async () => {
  const project = createProject({ name: 'Notes', key: 'NO', repo_path: env.repoPath });
  const first = createIssue({
    project_id: project.id,
    title: 'First issue',
    status: 'todo',
    mode: 'auto',
  });
  const done = await runIssuePipeline(first.id, {
    runner: makeFakeRunner({ qa: 'pass' }),
    config: getConfig(),
  });
  assert.equal(done.ok, true);

  const notes = listRecentNotes(project.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.content, new RegExp(`\\[${getIssue(first.id)!.key}\\]`));
  assert.match(notes[0]!.content, /Implemented and wrote the file/);

  // A later issue in the same project gets the learning injected into its prompts.
  const inputs: AgentRunInput[] = [];
  const later = createIssue({
    project_id: project.id,
    title: 'Second issue',
    status: 'todo',
    mode: 'auto',
  });
  await runIssuePipeline(later.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config: getConfig(),
  });
  assert.match(inputs[0]!.prompt, /Learnings from recently completed issues/);
  assert.match(inputs[0]!.prompt, /First issue/);
});

test('a rejected resume falls back to one fresh session per phase', async () => {
  const project = createProject({ name: 'Resume', key: 'RS', repo_path: env.repoPath });
  const issue = createIssue({
    project_id: project.id,
    title: 'Stale session',
    status: 'todo',
    mode: 'auto',
  });

  await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ failPhase: 'qa' }),
    config: getConfig(),
  });

  // Attempt 2 with a runner whose resume path dies at startup (like a stale --resume id).
  const inputs: AgentRunInput[] = [];
  const inner = makeFakeRunner({ qa: 'pass', inputs });
  const runner: AgentRunner = (input, onEvent) => {
    if (input.resumeSessionId) {
      inputs.push(input);
      return Promise.resolve({
        ok: false,
        sessionId: null,
        text: '',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, num_turns: 0 },
        durationMs: 1,
        error: 'No conversation found with session ID',
      });
    }
    return inner(input, onEvent);
  };

  const result = await runIssuePipeline(issue.id, { runner, config: getConfig(), attempt: 2 });
  assert.equal(result.ok, true);
  assert.equal(inputs.filter((i) => i.resumeSessionId).length, 1, 'only the failed QA phase resumes');
  assert.equal(inputs.filter((i) => !i.resumeSessionId).length, 1, 'only the QA fallback runs fresh');
});
