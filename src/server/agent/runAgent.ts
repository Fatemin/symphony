import { runClaudeCode } from './claudeRunner';
import { runCodex } from './codexRunner';
import type { AgentRunner } from './types';

/**
 * Single-runner DI seam over multiple agent CLIs. The orchestrator/phases hold ONE `AgentRunner`
 * and pass it through unchanged; this dispatcher branches on `input.agent` so the choice of CLI is
 * data, not a wiring decision. Tests still inject their own single fake runner and stay green.
 */
export function makeAgentRunner(runners: { claude: AgentRunner; codex: AgentRunner }): AgentRunner {
  return (input, onEvent) =>
    (input.agent === 'codex' ? runners.codex : runners.claude)(input, onEvent);
}

/** Production runner: Claude Code + Codex. */
export const runAgent: AgentRunner = makeAgentRunner({ claude: runClaudeCode, codex: runCodex });
