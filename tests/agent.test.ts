import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { resultErrorMessage } = await import('../src/server/agent/claudeRunner');
const { loadWorkflow } = await import('../src/server/core/workflow');
const { parseProjectConfig } = await import('../src/server/core/projectConfig');
const { parseQa } = await import('../src/server/core/prompt');

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
