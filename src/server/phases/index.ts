import type { IssueStatus, RunPhase } from '../../shared/types';
import type { EngineConfig } from '../core/config';
import { agentBranch } from '../core/keys';
import { loadWorkflow } from '../core/workflow';
import type { AgentErrorKind, AgentEvent, AgentRunner } from '../agent/types';
import { getProject } from '../repo/projects';
import { getIssue, updateIssue } from '../repo/issues';
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
import { listTasks } from '../repo/tasks';
import { appendEvent, type EventWithCursor } from '../repo/events';
import { ensureWorktree, worktreePathFor } from '../workspace/worktree';
import { log } from '../observability/logger';
import { runPlan } from './plan';
import { runImplement } from './implement';
import { runQa } from './qa';
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
  // Mark work as started + persist the worktree/branch metadata in one update.
  updateIssue(issueId, {
    status: 'in_progress',
    base_branch: baseBranch,
    branch_name: branch,
    worktree_path: worktreePath,
  });

  const fresh = getIssue(issueId)!; // re-read with branch fields + in_progress status
  const workflow = loadWorkflow(project.repo_path); // optional per-repo policy

  // Cross-run memory: why the last attempt failed + distilled learnings from past issues.
  const failure = attempt > 1 ? lastFailure(issueId) : null;
  const notes = listRecentNotes(project.id);
  let implementReport: string | null = latestSuccessfulRun(issueId, 'implement')?.report ?? null;

  for (const phase of PHASE_ORDER) {
    if (opts.signal?.aborted) return fail(issueId, phase, 'aborted', opts);

    const skipped = skipCompletedPhase(issueId, phase);
    if (skipped) {
      if (phase === 'implement') {
        implementReport = latestSuccessfulRun(issueId, 'implement')?.report ?? implementReport;
      }
      emit(opts, {
        issue_id: issueId,
        kind: 'phase.skip',
        message: `${phase} skipped (${skipped})`,
        data: { phase, reason: skipped },
      });
      continue;
    }

    const resumeSessionId = resumeSessionIdFor(issueId, phase);
    const run = createRun(issueId, phase, attempt);
    emit(opts, { issue_id: issueId, run_id: run.id, kind: 'phase.start', message: `${phase} started`, data: { phase } });

    const ctx: PhaseContext = {
      project,
      issue: fresh,
      phase,
      worktreePath,
      attempt,
      config: opts.config,
      workflow,
      runner: opts.runner,
      signal: opts.signal,
      onAgentEvent: (event) => persistAgentEvent(opts, issueId, run.id, phase, event),
      lastFailure: failure,
      notes,
      resumeSessionId,
      implementReport: phase === 'qa' ? implementReport : null,
    };

    let outcome: PhaseOutcome;
    try {
      outcome = phase === 'plan' ? await runPlan(ctx) : phase === 'implement' ? await runImplement(ctx) : await runQa(ctx);
    } catch (e) {
      outcome = { ok: false, usage: zeroUsage(), sessionId: null, summary: `${phase} threw`, error: asMsg(e) };
    }

    updateRunUsage(run.id, { session_id: outcome.sessionId, ...outcome.usage });
    finishRun(run.id, outcome.ok ? 'succeeded' : 'failed', outcome.error ?? null, outcome.report ?? null);
    emit(opts, {
      issue_id: issueId,
      run_id: run.id,
      kind: 'phase.end',
      level: outcome.ok ? 'info' : 'warn',
      message: outcome.summary,
      data: { phase, ok: outcome.ok },
    });

    if (!outcome.ok) {
      log.warn('phase failed', { issue: issue.key, phase, error: outcome.error });
      return {
        ok: false,
        finalStatus: 'in_progress',
        failedPhase: phase,
        error: outcome.error,
        errorKind: outcome.errorKind,
        retryAfterMs: outcome.retryAfterMs,
      };
    }
    if (phase === 'implement') implementReport = outcome.report ?? null;
  }

  // Distill the implement report into the project's long-term notes (fed to future prompts).
  if (implementReport) {
    recordIssueNote(project.id, issueId, `[${fresh.key}] ${fresh.title} — ${noteFromReport(implementReport)}`);
  }

  // All phases passed → park at the review gate (or finish if the gate is disabled).
  const finalStatus: IssueStatus = fresh.require_review ? 'review' : 'done';
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

function skipCompletedPhase(issueId: string, phase: RunPhase): string | null {
  const latest = latestRun(issueId, phase);
  if (!latest || latest.status !== 'succeeded') return null;
  if (phase === 'plan') {
    return listTasks(issueId).length > 0 ? 'previous successful plan with persisted tasks' : null;
  }
  if (phase === 'implement') {
    const qa = latestRun(issueId, 'qa');
    if (qa && qa.started_at > latest.started_at && qa.status === 'failed' && isQaVerdictFailure(qa.error)) {
      return null;
    }
    return 'previous successful implementation';
  }
  return 'previous successful QA';
}

function resumeSessionIdFor(issueId: string, phase: RunPhase): string | null {
  const latest = latestRun(issueId, phase);
  if (latest?.status === 'succeeded') return null;
  return lastSessionId(issueId, phase);
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
