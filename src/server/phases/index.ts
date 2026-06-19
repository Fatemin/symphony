import type { IssueStatus, RunPhase, RunStatus } from '../../shared/types';
import type { EngineConfig } from '../core/config';
import { agentBranch } from '../core/keys';
import { mergeProjectConfigs } from '../core/projectConfig';
import { loadWorkflow } from '../core/workflow';
import type { AgentErrorKind, AgentEvent, AgentRunner } from '../agent/types';
import { getProject } from '../repo/projects';
import { getIssue, isTerminal, updateIssue } from '../repo/issues';
import {
  createRun,
  finishRun,
  lastFailure,
  lastSessionId,
  latestRun,
  latestSuccessfulRun,
  updateRunUsage,
} from '../repo/runs';
import { listRecentNotes, noteFromReport, recordIssueNote } from '../repo/notes';
import { listProjectSkills } from '../repo/projectSkills';
import { getRevision } from '../repo/revisions';
import { listStoryReferenceContexts } from '../repo/issueRelations';
import { listTasks } from '../repo/tasks';
import { appendEvent, type EventWithCursor } from '../repo/events';
import { ensureWorktree, installCommitGuardHook, worktreePathFor } from '../workspace/worktree';
import { materializeSkills } from '../workspace/skills';
import { runVerificationCommands } from '../workspace/verification';
import { log } from '../observability/logger';
import { runPlan } from './plan';
import { runImplement } from './implement';
import { runQa } from './qa';
import { runMerge } from './merge';
import { PHASE_ORDER, type PhaseContext, type PhaseOutcome } from './types';

export interface RunPipelineOptions {
  runner: AgentRunner;
  config: EngineConfig;
  attempt?: number;
  signal?: AbortSignal;
  /** Called for every persisted event (lets the SSE layer push without polling). */
  onEvent?: (event: EventWithCursor) => void;
}

export interface PipelineResult {
  ok: boolean;
  finalStatus: IssueStatus;
  failedPhase?: RunPhase;
  error?: string;
  errorKind?: AgentErrorKind;
  retryAfterMs?: number;
  park?: boolean;
}

/**
 * Execute one issue end-to-end: prepare its worktree, run plan → implement → qa, persisting a
 * run row + activity events per phase, then transition the issue to `review` (or `done` when the
 * gate is disabled). On any phase failure it returns ok:false and leaves the issue `in_progress`
 * for the orchestrator to retry. This is the whole Execution Layer for one issue.
 */
export async function runIssuePipeline(
  issueId: string,
  opts: RunPipelineOptions,
): Promise<PipelineResult> {
  const attempt = opts.attempt ?? 1;
  const issue = getIssue(issueId);
  if (!issue) return fail(issueId, 'plan', 'issue not found', opts);
  const project = getProject(issue.project_id);
  if (!project) return fail(issueId, 'plan', 'project not found', opts);
  if (!project.repo_path) {
    return fail(issueId, 'plan', 'project has no repo_path — cannot run agents', opts);
  }

  const workflow = loadWorkflow(project.repo_path); // optional per-repo policy
  const projectConfig = mergeProjectConfigs(project.config, workflow?.config);

  // Prepare the isolated worktree (Safety Invariants enforced inside ensureWorktree).
  const baseBranch = issue.base_branch ?? project.default_branch;
  const branch = issue.branch_name ?? agentBranch(issue.key);
  const worktreePath = worktreePathFor(opts.config.workspace_root, project.key, issue.key);
  try {
    await ensureWorktree({
      repoPath: project.repo_path,
      baseBranch,
      branch,
      worktreePath,
      workspaceRoot: opts.config.workspace_root,
    });
  } catch (e) {
    return fail(issueId, 'plan', `worktree setup failed: ${asMsg(e)}`, opts);
  }
  try {
    await installCommitGuardHook(worktreePath, projectConfig.commit_guard);
  } catch (e) {
    return fail(issueId, 'plan', `commit guard setup failed: ${asMsg(e)}`, opts);
  }
  // Mark work as started + persist the worktree/branch metadata in one update.
  updateIssue(issueId, {
    status: 'in_progress',
    base_branch: baseBranch,
    branch_name: branch,
    worktree_path: worktreePath,
  });

  // Materialize the project's enabled skills into the worktree so agents can reference them
  // (Claude Code auto-loads <cwd>/.claude/skills/<slug>/SKILL.md). Re-run every dispatch so a reused
  // worktree reflects the current DB. Best-effort: a failure must not block the pipeline.
  const skills = listProjectSkills(project.id);
  try {
    await materializeSkills(worktreePath, skills);
  } catch (e) {
    log.warn('skill materialization failed', { issue: issue.key, error: asMsg(e) });
  }

  const fresh = getIssue(issueId)!; // re-read with branch fields + in_progress status
  const objectiveVerification = projectConfig.verification.commands.length > 0;

  // Multi-round revisions (§ loop engineering): every skip/resume/failure query is scoped to the
  // current round so round N re-runs plan→implement→qa cold on top of round N-1's commits. Round 1
  // has no revision; round >= 2 carries the human's "request changes" feedback into every phase.
  const round = fresh.round;
  const revisionFeedback = round > 1 ? getRevision(issueId, round)?.feedback ?? null : null;

  // Cross-run memory: why the last attempt failed + distilled learnings from past issues.
  const failure = attempt > 1 ? lastFailure(issueId, round) : null;
  const notes = listRecentNotes(project.id);
  const storyContext = listStoryReferenceContexts(issueId);
  let implementReport: string | null = latestSuccessfulRun(issueId, 'implement', round)?.report ?? null;

  for (const phase of PHASE_ORDER) {
    if (opts.signal?.aborted) return fail(issueId, phase, 'aborted', opts);

    const skipped = skipCompletedPhase(issueId, phase, round);
    if (skipped) {
      if (phase === 'implement') {
        implementReport = latestSuccessfulRun(issueId, 'implement', round)?.report ?? implementReport;
      }
      emit(opts, {
        issue_id: issueId,
        kind: 'phase.skip',
        message: `${phase} skipped (${skipped})`,
        data: { phase, reason: skipped },
      });
      continue;
    }

    const resumeSessionId = resumeSessionIdFor(issueId, phase, round);
    const run = createRun(issueId, phase, attempt, round);
    emit(opts, { issue_id: issueId, run_id: run.id, kind: 'phase.start', message: `${phase} started`, data: { phase } });

    const ctx: PhaseContext = {
      project,
      issue: fresh,
      phase,
      worktreePath,
      attempt,
      config: opts.config,
      projectConfig,
      workflow,
      runner: opts.runner,
      signal: opts.signal,
      onAgentEvent: (event) => persistAgentEvent(opts, issueId, run.id, phase, event),
      lastFailure: failure,
      notes,
      storyContext,
      skills: skills.filter((s) => s.enabled),
      resumeSessionId,
      implementReport: phase === 'qa' ? implementReport : null,
      round,
      revisionFeedback,
    };

    let outcome: PhaseOutcome;
    try {
      outcome = phase === 'plan' ? await runPlan(ctx) : phase === 'implement' ? await runImplement(ctx) : await runQa(ctx);
    } catch (e) {
      outcome = { ok: false, usage: zeroUsage(), sessionId: null, summary: `${phase} threw`, error: asMsg(e) };
    }

    updateRunUsage(run.id, { session_id: outcome.sessionId, ...outcome.usage });
    const auxiliaryQa = phase === 'qa' && objectiveVerification && !outcome.ok;
    const runStatus = runStatusForOutcome(issueId, outcome);
    finishRun(run.id, runStatus, outcome.error ?? null, outcome.report ?? null);
    emit(opts, {
      issue_id: issueId,
      run_id: run.id,
      kind: 'phase.end',
      level: outcome.ok || runStatus === 'cancelled' ? 'info' : 'warn',
      message: runStatus === 'cancelled' ? `${phase} cancelled` : outcome.summary,
      data: { phase, ok: outcome.ok, status: runStatus, auxiliary: auxiliaryQa },
    });

    if (!outcome.ok && !auxiliaryQa) {
      if (runStatus === 'cancelled') {
        log.info('phase cancelled', { issue: issue.key, phase, error: outcome.error });
      } else {
        log.warn('phase failed', { issue: issue.key, phase, error: outcome.error });
      }
      return {
        ok: false,
        finalStatus: getIssue(issueId)?.status ?? 'in_progress',
        failedPhase: phase,
        error: outcome.error,
        errorKind: outcome.errorKind,
        retryAfterMs: outcome.retryAfterMs,
      };
    }
    if (phase === 'implement') implementReport = outcome.report ?? null;
  }

  if (objectiveVerification) {
    let verification;
    try {
      verification = await runVerificationCommands(worktreePath, projectConfig.verification.commands, opts.signal);
    } catch (e) {
      const error = `verification setup failed: ${asMsg(e)}`;
      emit(opts, { issue_id: issueId, kind: 'verification.failed', level: 'error', message: error });
      return { ok: false, finalStatus: 'in_progress', failedPhase: 'qa', error };
    }
    for (const command of verification.commands) {
      emit(opts, {
        issue_id: issueId,
        kind: command.ok ? 'verification.command_passed' : 'verification.command_failed',
        level: command.ok ? 'info' : 'error',
        message: `${command.command} ${command.ok ? 'passed' : 'failed'} (${command.duration_ms}ms)`,
        data: command,
      });
    }
    if (!verification.ok) {
      if (verification.action === 'park') updateIssue(issueId, { mode: 'manual' });
      emit(opts, {
        issue_id: issueId,
        kind: 'verification.failed',
        level: 'error',
        message: verification.summary,
        data: verification,
      });
      return {
        ok: false,
        finalStatus: 'in_progress',
        failedPhase: 'qa',
        error: verification.summary,
        park: verification.action === 'park',
      };
    }
    emit(opts, {
      issue_id: issueId,
      kind: 'verification.passed',
      message: verification.summary,
      data: verification,
    });
  }

  // Distill the implement report into the project's long-term notes (fed to future prompts).
  // Recorded only after verification passes so a failed-then-retried issue doesn't double-log.
  if (implementReport) {
    recordIssueNote(project.id, issueId, `[${fresh.key}] ${fresh.title} — ${noteFromReport(implementReport)}`);
  }

  // All phases passed → park at the review gate (or finish if the gate is disabled).
  const finalStatus: IssueStatus = fresh.require_review || projectConfig.promotion.mode === 'pull-request' ? 'review' : 'done';

  // §SYM-16: the autonomous `done` path historically marked the issue done WITHOUT pushing — the
  // branch never reached the remote. Land the work with a merge agent first. The review /
  // pull-request paths skip this entirely: the human approve gate (POST /:id/approve) owns
  // promotion there, so running merge here would double-merge. Unlike plan→implement→qa this is
  // intentionally NOT memoized via skipCompletedPhase, so each retry re-pushes from a fresh
  // session. Worktree/branch cleanup stays with the approve route; leaving the branch in place is
  // fine because the work has already landed on the remote.
  if (finalStatus === 'done') {
    const run = createRun(issueId, 'merge', attempt, round);
    emit(opts, { issue_id: issueId, run_id: run.id, kind: 'phase.start', message: 'merge started', data: { phase: 'merge' } });
    const ctx: PhaseContext = {
      project,
      issue: fresh,
      phase: 'merge',
      worktreePath,
      attempt,
      config: opts.config,
      projectConfig,
      workflow,
      runner: opts.runner,
      signal: opts.signal,
      onAgentEvent: (event) => persistAgentEvent(opts, issueId, run.id, 'merge', event),
      lastFailure: failure,
      notes,
      storyContext,
      skills: skills.filter((s) => s.enabled),
      resumeSessionId: null, // fresh session every attempt — a retry must re-push, not resume a dead one
      round,
      revisionFeedback,
    };

    let outcome: PhaseOutcome;
    try {
      outcome = await runMerge(ctx);
    } catch (e) {
      outcome = { ok: false, usage: zeroUsage(), sessionId: null, summary: 'merge threw', error: asMsg(e) };
    }
    updateRunUsage(run.id, { session_id: outcome.sessionId, ...outcome.usage });
    const runStatus = runStatusForOutcome(issueId, outcome);
    finishRun(run.id, runStatus, outcome.error ?? null, outcome.report ?? null);
    emit(opts, {
      issue_id: issueId,
      run_id: run.id,
      kind: 'phase.end',
      level: outcome.ok || runStatus === 'cancelled' ? 'info' : 'warn',
      message: runStatus === 'cancelled' ? 'merge cancelled' : outcome.summary,
      data: { phase: 'merge', ok: outcome.ok, status: runStatus },
    });
    if (!outcome.ok) {
      log.warn('merge failed', { issue: issue.key, error: outcome.error });
      return {
        ok: false,
        finalStatus: getIssue(issueId)?.status ?? 'in_progress',
        failedPhase: 'merge',
        error: outcome.error,
        errorKind: outcome.errorKind,
        retryAfterMs: outcome.retryAfterMs,
      };
    }
  }

  updateIssue(issueId, { status: finalStatus });
  emit(opts, {
    issue_id: issueId,
    kind: 'pipeline.done',
    message: finalStatus === 'review' ? 'awaiting human review' : 'completed',
    data: { finalStatus },
  });
  log.info('pipeline complete', { issue: issue.key, finalStatus });
  return { ok: true, finalStatus };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function persistAgentEvent(
  opts: RunPipelineOptions,
  issueId: string,
  runId: string,
  phase: RunPhase,
  event: AgentEvent,
): void {
  if (event.type === 'usage') {
    updateRunUsage(runId, event.usage);
    return; // token accounting only, not a log line
  }
  if (event.type === 'text') return; // prose deltas are not persisted (avoids log bloat)

  if (event.type === 'tool_use') {
    const input = JSON.stringify(event.input ?? {}).slice(0, 200);
    emit(opts, { issue_id: issueId, run_id: runId, kind: 'agent.tool', message: `${phase}: ${event.name} ${input}`, data: { phase, name: event.name } });
  } else if (event.type === 'tool_result') {
    emit(opts, { issue_id: issueId, run_id: runId, kind: 'agent.tool_result', level: 'debug', message: event.text.slice(0, 300), data: { phase } });
  } else if (event.type === 'init') {
    emit(opts, { issue_id: issueId, run_id: runId, kind: 'agent.init', message: `${phase}: session ${event.sessionId.slice(0, 8)} (${event.model})`, data: { phase, sessionId: event.sessionId } });
  } else if (event.type === 'error') {
    emit(opts, { issue_id: issueId, run_id: runId, kind: 'agent.error', level: 'error', message: event.message, data: { phase } });
  }
}

function emit(
  opts: RunPipelineOptions,
  e: { issue_id?: string; run_id?: string; kind: string; level?: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown },
): void {
  const row = appendEvent(e);
  opts.onEvent?.(row);
}

function skipCompletedPhase(issueId: string, phase: RunPhase, round: number): string | null {
  const latest = latestRun(issueId, phase, round);
  if (!latest || latest.status !== 'succeeded') return null;
  if (phase === 'plan') {
    // Round-scoped: a new round has no round-N plan run yet, so this returns null and plan re-runs.
    return listTasks(issueId).length > 0 ? 'previous successful plan with persisted tasks' : null;
  }
  if (phase === 'implement') {
    const qa = latestRun(issueId, 'qa', round);
    if (qa && qa.started_at > latest.started_at && qa.status === 'failed' && isQaVerdictFailure(qa.error)) {
      return null;
    }
    return 'previous successful implementation';
  }
  return 'previous successful QA';
}

function runStatusForOutcome(issueId: string, outcome: PhaseOutcome): RunStatus {
  if (outcome.ok) return 'succeeded';
  const issue = getIssue(issueId);
  if (outcome.error === 'aborted' && issue && isTerminal(issue.status)) return 'cancelled';
  return 'failed';
}

function resumeSessionIdFor(issueId: string, phase: RunPhase, round: number): string | null {
  const latest = latestRun(issueId, phase, round);
  if (latest?.status === 'succeeded') return null;
  return lastSessionId(issueId, phase, round);
}

function isQaVerdictFailure(error: string | null): boolean {
  return !!error && /^QA failed:/i.test(error);
}

function fail(issueId: string, phase: RunPhase, error: string, opts: RunPipelineOptions): PipelineResult {
  emit(opts, { issue_id: issueId, kind: 'pipeline.error', level: 'error', message: error, data: { phase } });
  log.error('pipeline failed', { issueId, phase, error });
  return { ok: false, finalStatus: getIssue(issueId)?.status ?? 'in_progress', failedPhase: phase, error };
}

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0, num_turns: 0 });
const asMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
