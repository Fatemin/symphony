import type { Issue, Project, RunPhase } from '../../shared/types';
import type { EngineConfig } from '../core/config';
import type { ProjectConfig } from '../core/projectConfig';
import type { WorkflowPolicy } from '../core/workflow';
import type { AgentEvent, AgentRunInput, AgentRunner, AgentUsage } from '../agent/types';

/** Everything a single phase needs to run. The runner is injected (DI seam for tests). */
export interface PhaseContext {
  project: Project;
  issue: Issue;
  worktreePath: string;
  attempt: number;
  config: EngineConfig;
  /** Effective per-project policy from DB config overlaid by WORKFLOW.md. */
  projectConfig: ProjectConfig;
  /** Optional per-repo policy from WORKFLOW.md (overrides config + appends prompt guidance). */
  workflow: WorkflowPolicy | null;
  runner: AgentRunner;
  /** Streamed agent events for this phase (persistence + SSE happen in the caller). */
  onAgentEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface PhaseOutcome {
  ok: boolean;
  usage: AgentUsage;
  sessionId: string | null;
  summary: string;
  error?: string;
}

export interface QaOutcome extends PhaseOutcome {
  pass: boolean;
}

/** Build the CLI input for a phase from context + config, honoring a per-project model. */
export function agentInput(
  ctx: PhaseContext,
  prompt: string,
  systemPrompt?: string,
): AgentRunInput {
  // Precedence: WORKFLOW.md → per-project model → engine config.
  return {
    cwd: ctx.worktreePath,
    prompt,
    systemPrompt,
    model: ctx.workflow?.model || ctx.project.model?.trim() || ctx.config.model,
    permissionMode: ctx.workflow?.permission_mode ?? ctx.config.permission_mode,
    maxTurns: ctx.workflow?.max_turns ?? ctx.config.max_turns,
    timeoutMs: ctx.config.phase_timeout_ms,
    cliPath: ctx.config.cli_path,
    signal: ctx.signal,
  };
}

export const PHASE_ORDER: RunPhase[] = ['plan', 'implement', 'qa'];
