import fs from 'node:fs';
import path from 'node:path';
import type { AgentResult, AgentRunInput, AgentRunner } from '../../src/server/agent/types';

type Phase = 'plan' | 'implement' | 'qa' | 'delivery' | 'merge';

export interface FakeRunnerOptions {
  /** Make QA return PASS (default) or FAIL. */
  qa?: 'pass' | 'fail';
  /** Make the merge phase return PASS (default) or FAIL — no real git is touched. */
  merge?: 'pass' | 'fail';
  /** Force a specific phase to fail (simulates agent error). */
  failPhase?: Phase;
  /** Fail the selected phase once (simulates a transient agent error), then behave normally. */
  failOncePhase?: Phase;
  /** Return a quota error once for the selected phase, then behave normally. */
  quotaOncePhase?: Phase;
  quotaRetryAfterMs?: number;
  /** File the "implement" phase writes into the worktree. */
  fileName?: string;
  fileContent?: string;
  implementReport?: string;
  /**
   * SYM-62: simulate the implement phase invoking a Claude Code skill (emits a `Skill` tool_use so
   * the pipeline records `agent.tool` `data.skill`). Default-off so the existing baseline tests,
   * which expect no skill usage, stay unchanged.
   */
  skill?: string;
  /** Count of calls per phase, for assertions (merge only present once that phase runs). */
  calls?: { plan: number; implement: number; qa: number; delivery?: number; merge?: number };
  /** Captured runner inputs in call order, for assertions. */
  inputs?: AgentRunInput[];
}

const usage = (n: number) => ({
  input_tokens: 100 * n,
  output_tokens: 50 * n,
  total_tokens: 150 * n,
  num_turns: n,
  cache_read_tokens: 700 * n,
  cache_creation_tokens: 70 * n,
});

/** Detect which phase a prompt belongs to (the prompts are distinctive). */
function phaseOf(prompt: string): Phase {
  if (prompt.includes('independent **QA engineer**')) return 'qa';
  if (prompt.includes('**delivery lead**')) return 'delivery';
  if (prompt.includes('**release engineer**')) return 'merge';
  if (prompt.includes('**implementing engineer**')) return 'implement';
  return 'plan';
}

/**
 * Deterministic stand-in for the Claude CLI: inspects the phase from the prompt and returns a
 * canned, well-formed response (plan JSON / a real file write / a QA verdict). No tokens, no CLI.
 */
export function makeFakeRunner(opts: FakeRunnerOptions = {}): AgentRunner {
  const counters = opts.calls ?? { plan: 0, implement: 0, qa: 0, delivery: 0, merge: 0 };
  let quotaReturned = false;
  let failedOnce = false;

  return async (input: AgentRunInput, onEvent): Promise<AgentResult> => {
    opts.inputs?.push(input);
    const phase = phaseOf(input.prompt);
    // `?? 0` keeps callers that pass a 3-phase `calls` literal valid: the `merge` key is only
    // added once that phase actually runs, so their deepEqual assertions stay unaffected.
    counters[phase] = (counters[phase] ?? 0) + 1;
    onEvent?.({ type: 'init', sessionId: `fake-${phase}-${counters[phase]}`, model: input.model });

    const result = (text: string, ok = true): AgentResult => {
      onEvent?.({ type: 'usage', usage: usage(1) });
      return {
        ok,
        sessionId: `fake-${phase}`,
        text,
        usage: usage(1),
        durationMs: 1,
        error: ok ? undefined : `fake ${phase} failure`,
      };
    };

    if (opts.quotaOncePhase === phase && !quotaReturned) {
      quotaReturned = true;
      onEvent?.({ type: 'usage', usage: usage(0) });
      return {
        ok: false,
        sessionId: `fake-${phase}`,
        text: '',
        usage: usage(0),
        durationMs: 1,
        error: "You've hit your session limit · resets 8pm",
        errorKind: 'quota',
        retryAfterMs: opts.quotaRetryAfterMs ?? 1000,
      };
    }

    if (opts.failPhase === phase) return result(`forced ${phase} failure`, false);
    if (opts.failOncePhase === phase && !failedOnce) {
      failedOnce = true;
      return result(`forced one-time ${phase} failure`, false);
    }

    if (phase === 'plan') {
      return result(
        'Here is the plan.\n\n```symphony-plan\n' +
          JSON.stringify({
            tasks: [{ role: 'impl', title: 'Add the thing', intent: 'satisfy the AC' }],
            key_files: [{ path: 'src/example.ts', purpose: 'primary implementation surface' }],
            context: 'Use the existing helper in src/example.ts and avoid rediscovering the route map.',
            notes: 'straightforward',
          }) +
          '\n```',
      );
    }

    if (phase === 'implement') {
      const file = path.join(input.cwd, opts.fileName ?? 'AGENT_OUTPUT.md');
      onEvent?.({ type: 'tool_use', name: 'Write', input: { file_path: file } });
      // SYM-62: optionally simulate a Claude Code skill invocation (the built-in `Skill` tool).
      if (opts.skill) onEvent?.({ type: 'tool_use', name: 'Skill', input: { skill: opts.skill } });
      fs.writeFileSync(file, opts.fileContent ?? '# done by fake agent\n');
      return result(opts.implementReport ?? 'Implemented and wrote the file.');
    }

    if (phase === 'qa') {
      const pass = (opts.qa ?? 'pass') === 'pass';
      return result(`QA_RESULT: ${pass ? 'PASS — meets the acceptance criteria' : 'FAIL — missing behavior'}`, true);
    }

    if (phase === 'delivery') {
      // Read-only summary: write nothing, just return the user-facing Markdown the UI renders.
      return result(
        '## What\'s new\nThe requested behavior now works.\n\n' +
          '## How to use it\nRun the app and try the new feature.\n\n' +
          '## Files changed\n- `AGENT_OUTPUT.md` — added by the fake agent.\n\n' +
          '## Docs updated\nNo documentation changes were needed.',
      );
    }

    // merge — no real git; just emit the verdict the pipeline parses.
    const merged = (opts.merge ?? 'pass') === 'pass';
    return result(`MERGE_RESULT: ${merged ? 'PASS — pushed the branch and merged it into base' : 'FAIL — could not push to the remote'}`, true);
  };
}
