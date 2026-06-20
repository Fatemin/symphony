import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { resultErrorMessage, runnerEnv } = await import('../src/server/agent/claudeRunner');
const { loadWorkflow } = await import('../src/server/core/workflow');
const { parseProjectConfig } = await import('../src/server/core/projectConfig');
const { resolveConfig, DEFAULT_SETTINGS } = await import('../src/server/core/config');
const { parseQa } = await import('../src/server/core/prompt');
const { resolveThinkingEffort } = await import('../src/server/phases/types');

test.after(() => env.cleanup());

test('resultErrorMessage maps CLI result subtypes to actionable failure reasons', () => {
  // The max-turns case matters most: the generic message hid two real implement deaths.
  const maxTurns = resultErrorMessage({ subtype: 'error_max_turns' }, 60);
  assert.match(maxTurns, /60-turn session cap/);
  assert.match(maxTurns, /resumes/i);

  // A populated result string is preserved verbatim.
  assert.equal(resultErrorMessage({ subtype: 'error_during_execution', result: 'boom' }, 60), 'boom');

  // Empty result + known subtype → subtype surfaces instead of the opaque fallback.
  assert.equal(
    resultErrorMessage({ subtype: 'error_during_execution' }, 60),
    'agent reported error (error_during_execution)',
  );

  // No diagnostics at all → the old generic message remains the last resort.
  assert.equal(resultErrorMessage({}, 60), 'agent reported error');
  assert.equal(resultErrorMessage({ result: '   ' }, 60), 'agent reported error');
});

test('WORKFLOW.md max_turns parses as a single number or a per-phase map', () => {
  const wf = path.join(env.repoPath, 'WORKFLOW.md');
  const write = (yaml: string) => fs.writeFileSync(wf, `---\n${yaml}\n---\n`);
  try {
    write('agent:\n  max_turns: 90');
    const flat = loadWorkflow(env.repoPath);
    assert.equal(flat?.max_turns, 90);
    assert.equal(flat?.max_turns_by_phase, undefined);

    write('agent:\n  max_turns:\n    implement: 150\n    qa: 40');
    const byPhase = loadWorkflow(env.repoPath);
    assert.equal(byPhase?.max_turns, undefined);
    assert.deepEqual(byPhase?.max_turns_by_phase, { implement: 150, qa: 40 });

    // Invalid values (negative / non-numeric / boolean) are dropped rather than passed to the CLI.
    write('agent:\n  max_turns:\n    implement: -5\n    qa: nope');
    const invalid = loadWorkflow(env.repoPath);
    assert.equal(invalid?.max_turns, undefined);
    assert.equal(invalid?.max_turns_by_phase, undefined);

    // YAML `true` must not coerce to a 1-turn cap (Number(true) === 1 would kill every phase).
    write('agent:\n  max_turns: true');
    assert.equal(loadWorkflow(env.repoPath)?.max_turns, undefined);

    // 0 means "uncapped", matching the engine setting (claudeRunner omits --max-turns for 0).
    write('agent:\n  max_turns: 0');
    assert.equal(loadWorkflow(env.repoPath)?.max_turns, 0);
  } finally {
    fs.unlinkSync(wf);
  }
});

test('parseQa takes the LAST verdict, so quoted policy text cannot shadow it', () => {
  // An agent restating repo policy ("…一律 QA_RESULT: FAIL。") before its real verdict used to
  // flip the run to FAIL via first-match parsing.
  const out = '按仓库策略，构建失败一律 QA_RESULT: FAIL。\n\n全部验收项通过。\n\nQA_RESULT: PASS — all criteria met';
  assert.deepEqual(parseQa(out), { pass: true, reason: 'all criteria met' });

  // Single-verdict outputs and the absent case keep their existing behavior.
  assert.equal(parseQa('QA_RESULT: FAIL — build broken').pass, false);
  assert.equal(parseQa('no verdict here').pass, false);
});

test('project config parses optional agent and phase prompt overrides', () => {
  const cfg = parseProjectConfig({
    agent: {
      permission_mode: 'acceptEdits',
      max_turns: { plan: 12, implement: 34, qa: '56' },
    },
    prompts: {
      plan: '  plan extra  ',
      implement: '',
      qa: 'qa extra',
    },
    verification: {
      commands: [{ command: 'npm test', timeout_ms: '120000' }],
    },
  });

  assert.equal(cfg.agent.permission_mode, 'acceptEdits');
  assert.deepEqual(cfg.agent.max_turns_by_phase, { plan: 12, implement: 34, qa: 56 });
  assert.equal(cfg.agent.max_turns, undefined);
  assert.deepEqual(cfg.prompts, { plan: 'plan extra', qa: 'qa extra' });
  assert.equal(cfg.verification.commands[0]!.timeout_ms, 120000);

  const invalid = parseProjectConfig({
    agent: {
      permission_mode: 'sudo',
      max_turns: true,
      max_turns_by_phase: { plan: null, implement: false },
    },
  });
  assert.equal(invalid.agent.permission_mode, undefined);
  assert.equal(invalid.agent.max_turns, undefined);
  assert.equal(invalid.agent.max_turns_by_phase, undefined);
});

test('project config parses the SYM-41 execution controls and drops invalid values', () => {
  const cfg = parseProjectConfig({
    agent: { enable_workflow_tool: true, thinking_effort: 'think-hard' },
  });
  assert.equal(cfg.agent.enable_workflow_tool, true);
  assert.equal(cfg.agent.thinking_effort, 'think-hard');

  // Unset ⇒ undefined (so agentInput/resolveThinkingEffort fall back to the engine default).
  const empty = parseProjectConfig({ agent: {} });
  assert.equal(empty.agent.enable_workflow_tool, undefined);
  assert.equal(empty.agent.thinking_effort, undefined);

  // Wrong types are rejected: a non-boolean toggle and an off-whitelist keyword are dropped.
  const bad = parseProjectConfig({
    agent: { enable_workflow_tool: 'yes', thinking_effort: 'megathink' },
  });
  assert.equal(bad.agent.enable_workflow_tool, undefined);
  assert.equal(bad.agent.thinking_effort, undefined);
});

test('resolveConfig coerces enable_workflow_tool as a boolean and whitelists thinking_effort', () => {
  // Defaults are the safe side: workflow off, thinking_effort a no-op.
  assert.equal(DEFAULT_SETTINGS.enable_workflow_tool, false);
  assert.equal(DEFAULT_SETTINGS.thinking_effort, 'none');

  const cfg = resolveConfig({ enable_workflow_tool: true, thinking_effort: 'ultrathink' });
  assert.equal(cfg.enable_workflow_tool, true);
  assert.equal(cfg.thinking_effort, 'ultrathink');

  // An off-whitelist thinking_effort must NOT slip through the loose string fallback.
  assert.equal(resolveConfig({ thinking_effort: 'bogus' }).thinking_effort, 'none');
  // The boolean key never goes through NUMERIC coercion (Number(false) === 0 would mislead).
  assert.equal(resolveConfig({ enable_workflow_tool: false }).enable_workflow_tool, false);
});

test('runnerEnv injects CLAUDE_CODE_DISABLE_WORKFLOWS only when workflows are disabled (SYM-41)', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/u' };

  const disabled = runnerEnv(base, true);
  assert.equal(disabled.CLAUDE_CODE_DISABLE_WORKFLOWS, '1');
  assert.equal(disabled.PATH, '/usr/bin', 'base env is preserved');
  assert.equal(base.PATH, '/usr/bin');
  assert.ok(!('CLAUDE_CODE_DISABLE_WORKFLOWS' in base), 'the base object is not mutated');

  const enabled = runnerEnv(base, false);
  assert.equal(enabled.CLAUDE_CODE_DISABLE_WORKFLOWS, undefined);
  assert.equal(enabled, base, 'enabled passes the env through unchanged');
});

test('resolveThinkingEffort precedence: issue ?? project ?? engine (SYM-46)', () => {
  // Build a minimal PhaseContext shape — only the three layers the resolver reads matter here.
  const resolve = (issue: unknown, project: unknown, engine: string) =>
    resolveThinkingEffort({
      issue: { thinking_effort: issue },
      projectConfig: { agent: { thinking_effort: project } },
      config: { thinking_effort: engine },
    } as unknown as Parameters<typeof resolveThinkingEffort>[0]);

  // Issue override wins outright over both lower layers.
  assert.equal(resolve('ultrathink', 'think', 'none'), 'ultrathink');
  // A null issue value inherits the project layer.
  assert.equal(resolve(null, 'think-hard', 'none'), 'think-hard');
  // Null issue + undefined project falls through to the engine default.
  assert.equal(resolve(null, undefined, 'think'), 'think');
  // Explicit issue 'none' is a deliberate override that beats a project 'ultrathink'.
  assert.equal(resolve('none', 'ultrathink', 'think'), 'none');
});
