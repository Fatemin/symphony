import fs from 'node:fs';
import path from 'node:path';
import type { AgentResult, AgentRunInput, AgentRunner } from '../../src/server/agent/types';

export interface FakeRunnerOptions {
  /** Make QA return PASS (default) or FAIL. */
  qa?: 'pass' | 'fail';
  /** Force a specific phase to fail (simulates agent error). */
  failPhase?: 'plan' | 'implement' | 'qa';
  /** File the "implement" phase writes into the worktree. */
  fileName?: string;
  fileContent?: string;
  /** Count of calls per phase, for assertions. */
  calls?: { plan: number; implement: number; qa: number };
}

const usage = (n: number) => ({
  input_tokens: 100 * n,
  output_tokens: 50 * n,
  total_tokens: 150 * n,
  num_turns: n,
});

/** Detect which phase a prompt belongs to (the prompts are distinctive). */
function phaseOf(prompt: string): 'plan' | 'implement' | 'qa' {
  if (prompt.includes('independent **QA engineer**')) return 'qa';
  if (prompt.includes('**implementing engineer**')) return 'implement';
  return 'plan';
}

/**
 * Deterministic stand-in for the Claude CLI: inspects the phase from the prompt and returns a
 * canned, well-formed response (plan JSON / a real file write / a QA verdict). No tokens, no CLI.
 */
export function makeFakeRunner(opts: FakeRunnerOptions = {}): AgentRunner {
  const counters = opts.calls ?? { plan: 0, implement: 0, qa: 0 };

  return async (input: AgentRunInput, onEvent): Promise<AgentResult> => {
    const phase = phaseOf(input.prompt);
    counters[phase]++;
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

    if (opts.failPhase === phase) return result(`forced ${phase} failure`, false);

    if (phase === 'plan') {
      return result(
        'Here is the plan.\n\n```symphony-plan\n' +
          JSON.stringify({
            tasks: [{ role: 'impl', title: 'Add the thing', intent: 'satisfy the AC' }],
            notes: 'straightforward',
          }) +
          '\n```',
      );
    }

    if (phase === 'implement') {
      const file = path.join(input.cwd, opts.fileName ?? 'AGENT_OUTPUT.md');
      onEvent?.({ type: 'tool_use', name: 'Write', input: { file_path: file } });
      fs.writeFileSync(file, opts.fileContent ?? '# done by fake agent\n');
      return result('Implemented and wrote the file.');
    }

    // qa
    const pass = (opts.qa ?? 'pass') === 'pass';
    return result(`QA_RESULT: ${pass ? 'PASS — meets the acceptance criteria' : 'FAIL — missing behavior'}`, true);
  };
}
