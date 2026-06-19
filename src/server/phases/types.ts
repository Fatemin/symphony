import type { AgentType, Issue, Project, ProjectNote, RunPhase, StoryReferenceContext } from '../../shared/types';
import type { EngineConfig } from '../core/config';
import type { ProjectConfig } from '../core/projectConfig';
import type { WorkflowPolicy } from '../core/workflow';
import type {
  AgentErrorKind,
  AgentEvent,
  AgentResult,
  AgentRunInput,
  AgentRunner,
  AgentUsage,
} from '../agent/types';

/** Everything a single phase needs to run. The runner is injected (DI seam for tests). */
export interface PhaseContext {
  project: Project;
  issue: Issue;
  /** Which pipeline phase this context drives (resolves per-phase WORKFLOW.md caps). */
  phase: RunPhase;
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
  /** Why the previous attempt failed (set on retries; threaded into prompts). */
  lastFailure?: { phase: RunPhase; error: string } | null;
  /** Recent project learnings injected into every phase prompt. */
  notes?: ProjectNote[];
  /** Explicit predecessor-story context snapshots injected into every phase prompt. */
  storyContext?: StoryReferenceContext[];
  /** Previous CLI session for this issue+phase — resumed on retries to skip re-exploration. */
  resumeSessionId?: string | null;
  /** The implement phase's final report (threaded into the QA prompt). */
  implementReport?: string | null;
  /** Current revision round (1 = first build, 2+ = re-run after the human requested changes). */
  round?: number;
  /** The human's "request changes" feedback for the current round (round >= 2), threaded into prompts. */
  revisionFeedback?: string | null;
}

export interface PhaseOutcome {
  ok: boolean;
  usage: AgentUsage;
  sessionId: string | null;
  summary: string;
  error?: string;
  errorKind?: AgentErrorKind;
  retryAfterMs?: number;
  /** Final agent text — later phases / the notes pipeline may reuse it. */
  report?: string;
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
  // Precedence: WORKFLOW.md → per-project overrides → engine config.
  // Agent resolves first because it picks which CLI binary + default model apply.
  const rawAgent = ctx.workflow?.agent || ctx.project.agent || ctx.config.agent;
  const agent: AgentType = rawAgent === 'codex' ? 'codex' : 'claude';
  return {
    agent,
    cwd: ctx.worktreePath,
    prompt,
    systemPrompt,
    resumeSessionId: ctx.resumeSessionId ?? undefined,
    model:
      ctx.workflow?.model ||
      ctx.project.model?.trim() ||
      (agent === 'codex' ? ctx.config.codex_model : ctx.config.model),
    permissionMode: ctx.workflow?.permission_mode ?? ctx.projectConfig.agent.permission_mode ?? ctx.config.permission_mode,
    maxTurns:
      ctx.workflow?.max_turns_by_phase?.[ctx.phase] ??
      ctx.workflow?.max_turns ??
      ctx.projectConfig.agent.max_turns_by_phase?.[ctx.phase] ??
      ctx.projectConfig.agent.max_turns ??
      ctx.config.max_turns,
    timeoutMs: ctx.config.phase_timeout_ms,
    cliPath: agent === 'codex' ? ctx.config.codex_cli_path : ctx.config.cli_path,
    signal: ctx.signal,
  };
}

/**
 * Run the phase's agent, resuming a previous session when the context carries one. If the resume
 * is rejected at startup (stale/garbage-collected session: no session id, no tokens, not an
 * abort), fall back to ONE fresh session — otherwise every retry would re-pick the same dead
 * session id and the issue could never recover.
 */
export async function runPhaseAgent(ctx: PhaseContext, prompt: string): Promise<AgentResult> {
  const input = agentInput(ctx, prompt);
  const result = await ctx.runner(input, ctx.onAgentEvent);
  const resumeRejected =
    !result.ok &&
    !!input.resumeSessionId &&
    !result.sessionId &&
    result.usage.total_tokens === 0 &&
    result.error !== 'aborted' &&
    result.errorKind !== 'quota';
  if (!resumeRejected) return result;
  return ctx.runner({ ...input, resumeSessionId: undefined }, ctx.onAgentEvent);
}

export const PHASE_ORDER: RunPhase[] = ['plan', 'implement', 'qa'];

/** Join phase-prompt additions (per-project config + WORKFLOW.md), dropping blanks; undefined if none. */
export const phasePrompt = (...parts: (string | undefined)[]): string | undefined =>
  parts.map((p) => p?.trim()).filter(Boolean).join('\n\n') || undefined;
