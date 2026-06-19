import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentResult, AgentRunInput } from '../src/server/agent/types';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { createProject, getProject, updateProject } = await import('../src/server/repo/projects');
const { createIssue } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { makeAgentRunner } = await import('../src/server/agent/runAgent');

test.after(() => env.cleanup());

test('project agent override round-trips through create + update', () => {
  const project = createProject({ name: 'Codex Persist', key: 'CP', repo_path: env.repoPath, agent: 'codex' });
  assert.equal(project.agent, 'codex');
  assert.equal(getProject(project.id)!.agent, 'codex');

  // Switching agents persists; clearing it (null) falls back to the global default.
  assert.equal(updateProject(project.id, { agent: 'claude' })!.agent, 'claude');
  assert.equal(updateProject(project.id, { agent: null })!.agent, null);

  // A project created with no agent inherits the global default (null in the row).
  const plain = createProject({ name: 'Plain', key: 'PL', repo_path: env.repoPath });
  assert.equal(plain.agent, null);
});

test('a codex project drives the pipeline with codex cliPath + default model', async () => {
  const config = getConfig();
  const project = createProject({ name: 'Codex Pipeline', key: 'CPL', repo_path: env.repoPath, agent: 'codex' });
  const issue = createIssue({ project_id: project.id, title: 'Use codex', status: 'todo', mode: 'auto' });

  const inputs: AgentRunInput[] = [];
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config,
  });

  assert.equal(result.ok, true);
  assert.equal(inputs.length, 4, 'plan, implement, qa, delivery each ran once');
  assert.ok(inputs.every((i) => i.agent === 'codex'), 'every phase routes to the codex agent');
  assert.ok(inputs.every((i) => i.cliPath === config.codex_cli_path), 'codex cliPath is used');
  assert.ok(inputs.every((i) => i.model === config.codex_model), 'codex default model is used when unset');
});

test('a default (claude) project keeps the claude cliPath + model', async () => {
  const config = getConfig();
  const project = createProject({ name: 'Claude Pipeline', key: 'CLP', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Use claude', status: 'todo', mode: 'auto' });

  const inputs: AgentRunInput[] = [];
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config,
  });

  assert.equal(result.ok, true);
  assert.ok(inputs.every((i) => i.agent === 'claude'), 'every phase routes to the claude agent');
  assert.ok(inputs.every((i) => i.cliPath === config.cli_path), 'claude cliPath is used');
  assert.ok(inputs.every((i) => i.model === config.model), 'claude default model is used');
});

test('makeAgentRunner routes on input.agent', async () => {
  const seen: string[] = [];
  const stub = (label: string) =>
    (async () => {
      seen.push(label);
      return { ok: true, sessionId: null, text: label, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, num_turns: 0 }, durationMs: 0 } satisfies AgentResult;
    });
  const runner = makeAgentRunner({
    claude: () => stub('claude')(),
    codex: () => stub('codex')(),
  });

  const base: Omit<AgentRunInput, 'agent'> = {
    cwd: env.repoPath,
    prompt: 'noop',
    model: 'm',
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
    disableWorkflows: true,
    timeoutMs: 1000,
    cliPath: 'x',
  };

  assert.equal((await runner({ ...base, agent: 'codex' })).text, 'codex');
  assert.equal((await runner({ ...base, agent: 'claude' })).text, 'claude');
  assert.deepEqual(seen, ['codex', 'claude']);
});
