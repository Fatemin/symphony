import fs from 'node:fs';
import { Hono } from 'hono';
import type { Issue, MergeConflictInfo } from '../../../shared/types';
import { runClaudeCode } from '../../agent/claudeRunner';
import type { AgentEvent } from '../../agent/types';
import {
  clearMergeConflict,
  createIssue,
  deleteIssue,
  getIssue,
  isTerminal,
  listIssues,
  setMergeConflict,
  setRound,
  setStatus,
  updateIssue,
} from '../../repo/issues';
import { addRevision, listRevisions } from '../../repo/revisions';
import { countAttachmentsForIssue, listAttachmentsByIssue } from '../../repo/attachments';
import { mergeProjectConfigs } from '../../core/projectConfig';
import { buildConflictPrompt } from '../../core/prompt';
import { loadWorkflow } from '../../core/workflow';
import { getProject, updateProject } from '../../repo/projects';
import { getConfig as readEngineConfig } from '../../repo/settings';
import { listTasks } from '../../repo/tasks';
import { listRuns } from '../../repo/runs';
import { appendEvent, listEvents } from '../../repo/events';
import { createFollowUpIssue, listIssueRelations } from '../../repo/issueRelations';
import { promoteViaPullRequest } from '../../workspace/promotion';
import { runVerificationCommands } from '../../workspace/verification';
import {
  deleteBranch,
  ensureBranch,
  getBranchDiff,
  mergeAgentBranch,
  pushBaseBranch,
  pushBranch,
  reconcileAndPushBase,
  removeWorktree,
  type MergeAgentBranchOptions,
  type MergeConflictResolverInput,
  type PushBaseResult,
} from '../../workspace/worktree';
import { DEFAULT_PREVIEW_COMMAND, getPreview, startPreview, stopPreview } from '../../preview/manager';
import { getOrchestrator } from '../../orchestrator/orchestrator';

export const issueRoutes = new Hono();

issueRoutes.get('/', (c) => {
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');
  let issues = listIssues(projectId);
  if (status) issues = issues.filter((i) => i.status === status);
  return c.json(issues);
});

issueRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.project_id || !body.title) {
    return c.json({ error: 'project_id and title are required' }, 400);
  }
  // SYM-35: cap the attachments linked at creation time (the new issue has none yet).
  const attachment_ids = normalizeAttachmentIds(body.attachment_ids);
  const max = readEngineConfig().max_attachments_per_item;
  if (attachment_ids.length > max) {
    return c.json({ error: `too many attachments (max ${max})` }, 400);
  }
  return c.json(createIssue({ ...body, attachment_ids }), 201);
});

issueRoutes.post('/:id/follow-ups', async (c) => {
  const source = getIssue(c.req.param('id'));
  if (!source) return c.json({ error: 'not found' }, 404);
  if (source.status !== 'done') {
    return c.json({ error: 'follow-up stories can only be created from a completed story' }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  if (!body.title || typeof body.title !== 'string') {
    return c.json({ error: 'title is required' }, 400);
  }

  const result = createFollowUpIssue(source.id, {
    title: body.title,
    type: body.type,
    description: body.description ?? null,
    acceptance_criteria: body.acceptance_criteria ?? null,
    labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
    priority: body.priority,
    status: body.status ?? 'todo',
    mode: body.mode,
    require_review: body.require_review,
    include_context: body.include_context !== false,
  });
  return c.json(result, 201);
});

// Full detail for the IssueDetail page: issue + planned tasks + run history + recent activity.
issueRoutes.get('/:id', (c) => {
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ error: 'not found' }, 404);
  return c.json({
    ...issue,
    tasks: listTasks(issue.id),
    runs: listRuns(issue.id),
    events: listEvents({ issue_id: issue.id, limit: 200 }),
    relations: listIssueRelations(issue.id),
    revisions: listRevisions(issue.id),
    attachments: listAttachmentsByIssue(issue.id), // SYM-35
  });
});

issueRoutes.patch('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const before = getIssue(c.req.param('id'));
  if (!before) return c.json({ error: 'not found' }, 404);
  // SYM-35: additive attachment linking — cap the issue's total at the per-item limit.
  const attachment_ids = normalizeAttachmentIds(body.attachment_ids);
  if (attachment_ids.length) {
    const max = readEngineConfig().max_attachments_per_item;
    if (countAttachmentsForIssue(before.id) + attachment_ids.length > max) {
      return c.json({ error: `too many attachments (max ${max})` }, 400);
    }
  }
  const issue = updateIssue(before.id, { ...body, attachment_ids });
  // If the issue was just cancelled/finished while a run is active, kick a tick so reconciliation
  // aborts it promptly instead of waiting for the next poll.
  if (issue && body.status && isTerminal(issue.status)) {
    getOrchestrator().cancelIssue(issue.id);
    if (issue.status === 'cancelled') {
      await cleanupIssueResources(before, { forceBranch: true, reason: 'cancelled' });
      return c.json(updateIssue(issue.id, { branch_name: null, worktree_path: null }));
    }
    void getOrchestrator().kick();
  }
  return c.json(issue);
});

issueRoutes.delete('/:id', async (c) => {
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.body(null, 204);
  getOrchestrator().cancelIssue(issue.id);
  await cleanupIssueResources(issue, { forceBranch: true, reason: 'deleted' });
  deleteIssue(issue.id);
  return c.body(null, 204);
});

// Activity feed (polling fallback for SSE; also the initial load).
issueRoutes.get('/:id/events', (c) => {
  const since = Number(c.req.query('since') ?? 0);
  return c.json(listEvents({ issue_id: c.req.param('id'), sinceCursor: since }));
});

// Review evidence: what the agent branch changed vs its base.
issueRoutes.get('/:id/diff', async (c) => {
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ error: 'not found' }, 404);
  const project = getProject(issue.project_id);
  if (!project?.repo_path || !issue.branch_name || !issue.base_branch) {
    return c.json({ available: false, base: issue.base_branch ?? '', branch: issue.branch_name ?? '', stat: '', files: [], patch: '', truncated: false });
  }
  return c.json(await getBranchDiff(project.repo_path, issue.base_branch, issue.branch_name));
});

// Approve the review gate: merge the agent branch into base, then mark done + clean up.
issueRoutes.post('/:id/approve', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    target_branch?: unknown;
    create_branch?: unknown;
    set_default_branch?: unknown;
  };
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ ok: false, reason: 'not found' }, 404);
  if (issue.status !== 'review') {
    return c.json({ ok: false, reason: `issue is ${issue.status}, not awaiting review` }, 409);
  }
  const project = getProject(issue.project_id);
  if (!project?.repo_path || !issue.branch_name || !issue.base_branch) {
    return c.json({ ok: false, reason: 'missing repo path or branch info — merge manually' }, 400);
  }

  const workflow = loadWorkflow(project.repo_path);
  const projectConfig = mergeProjectConfigs(project.config, workflow?.config);
  const targetBranch = typeof body.target_branch === 'string' && body.target_branch.trim()
    ? body.target_branch.trim()
    : projectConfig.promotion.mode === 'pull-request'
      ? projectConfig.promotion.base_branch ?? issue.base_branch ?? project.default_branch
      : issue.base_branch;
  const sourceBranch = issue.base_branch ?? project.default_branch;
  const createBranch = body.create_branch === true;
  const ensured = await ensureBranch(project.repo_path, targetBranch, sourceBranch, {
    create: createBranch,
    remote: projectConfig.promotion.remote,
  });
  if (!ensured.ok) {
    const reason = ensured.reason ?? `branch ${targetBranch} not found`;
    if (!createBranch && reason.includes('not found')) {
      return c.json({ ok: false, reason: `${reason} — enable create_branch to create it first` }, 409);
    }
    return c.json({ ok: false, reason }, 409);
  }
  const setDefaultBranch = body.set_default_branch === true;

  if (projectConfig.promotion.mode === 'pull-request') {
    if (!issue.worktree_path || !fs.existsSync(issue.worktree_path)) {
      return c.json({ ok: false, reason: 'missing issue worktree — cannot rebase and verify before opening a PR' }, 400);
    }
    const baseBranch = targetBranch;
    if (ensured.created) {
      const pushBase = await pushBranch(project.repo_path, projectConfig.promotion.remote, baseBranch);
      if (!pushBase.ok) return c.json(pushBase, 409);
    }
    const promotion = await promoteViaPullRequest({
      project,
      issue,
      branch: issue.branch_name,
      baseBranch,
      worktreePath: issue.worktree_path,
      config: projectConfig,
    });
    if (!promotion.ok) {
      appendEvent({
        issue_id: issue.id,
        kind: 'approve.failed',
        level: 'error',
        message: promotion.reason ?? 'pull request promotion failed',
        data: promotion,
      });
      return c.json(promotion, 409);
    }
    if (setDefaultBranch) updateProject(project.id, { default_branch: baseBranch });
    updateIssue(issue.id, { base_branch: baseBranch });
    // With auto_merge off, opening the PR is the completion/handoff point — Symphony has nothing
    // left to do, so a single approve must reach 'done'. Only when auto_merge is on AND the PR
    // isn't mergeable yet do we keep the issue parked so a re-approve re-polls the PR state.
    const handoffDone = promotion.merged || !projectConfig.promotion.auto_merge;
    appendEvent({
      issue_id: issue.id,
      kind: promotion.merged ? 'approve.pr_merged' : 'approve.pr_opened',
      message: promotion.merged
        ? `approved — PR merged by platform checks (${promotion.pr_url})`
        : handoffDone
          ? `approved — opened PR against ${baseBranch} and marked done (handoff): ${promotion.pr_url}`
          : `approved — opened PR against ${baseBranch}: ${promotion.pr_url}`,
      data: { base: baseBranch, branch: issue.branch_name, pr_url: promotion.pr_url, merged: promotion.merged, done: handoffDone, created_branch: ensured.created, set_default_branch: setDefaultBranch },
    });
    if (handoffDone) {
      await cleanupIssueResources(issue, { forceBranch: false, reason: 'approved' });
      updateIssue(issue.id, { status: 'done', branch_name: null, worktree_path: null });
    }
    return c.json({ ok: true, pr_url: promotion.pr_url, merged: promotion.merged ?? false, done: handoffDone, target_branch: baseBranch });
  }

  // §SYM-18 / SYM-29: the local merge + remote push, plus the git-conflict decoration on failure.
  // Approve pushes via pushBaseBranch (fails loudly on a diverged remote); the marker it leaves powers
  // the board badge + the agent-backed resolve-conflict endpoint.
  const outcome = await finalizeDirectMerge(issue, project, projectConfig, workflow, {
    targetBranch,
    setDefaultBranch,
    createdBranch: ensured.created,
    pushBase: (remote, branch) => pushBaseBranch(project.repo_path!, remote, branch),
  });
  return c.json(outcome.body, outcome.status);
});

interface DirectMergeOutcome {
  status: 200 | 409;
  body: Record<string, unknown>;
}

/**
 * Shared direct-merge finalize for the approve + resolve-conflict review-gate actions (SYM-29):
 * merge the agent branch into the target base (agent resolver on conflicts), push the moved base via
 * the supplied strategy, then mark the issue done and clean up. The two callers differ ONLY in how
 * they push — approve uses pushBaseBranch (fail-loudly), resolve-conflict uses reconcileAndPushBase
 * (agent-backed remote reconcile). On a merge conflict (conflicted files) or a diverged-remote push
 * it persists Issue.merge_conflict and leaves the issue in 'review' for a re-approve / resolve; on
 * success it clears that decoration. Non-conflict failures (auth/network, dirty checkout) fail the
 * approve loudly as before WITHOUT a spurious git-conflict badge.
 */
async function finalizeDirectMerge(
  issue: Issue,
  project: NonNullable<ReturnType<typeof getProject>>,
  projectConfig: ReturnType<typeof mergeProjectConfigs>,
  workflow: ReturnType<typeof loadWorkflow>,
  opts: {
    targetBranch: string;
    setDefaultBranch: boolean;
    createdBranch: boolean;
    pushBase: (remote: string, branch: string) => Promise<PushBaseResult>;
  },
): Promise<DirectMergeOutcome> {
  const { targetBranch } = opts;
  const remote = projectConfig.promotion.remote;

  const merge = await mergeAgentBranch(
    project.repo_path!,
    targetBranch,
    issue.branch_name!,
    `Merge ${issue.key}: ${issue.title}`,
    mergeOptionsForApproval(issue, project, projectConfig, workflow),
  );
  if (!merge.ok) {
    const files = merge.conflicted_files ?? [];
    if (files.length > 0) {
      setMergeConflict(issue.id, {
        kind: 'merge',
        target_branch: targetBranch,
        remote,
        reason: merge.reason ?? 'merge conflict',
        files,
        detected_at: new Date().toISOString(),
      });
      appendEvent({
        issue_id: issue.id,
        kind: 'conflict.detected',
        level: 'warn',
        message: `git conflict — merging ${issue.branch_name} into ${targetBranch} needs resolution`,
        data: { kind: 'merge', files, reason: merge.reason },
      });
    }
    appendEvent({ issue_id: issue.id, kind: 'approve.failed', level: 'error', message: merge.reason ?? 'merge failed', data: merge });
    return { status: 409, body: { ...merge, conflict: files.length > 0 ? { kind: 'merge', files } : undefined } };
  }

  let pushed = false;
  if (projectConfig.promotion.push) {
    const push = await opts.pushBase(remote, targetBranch);
    if (!push.ok) {
      const reason = push.reason ?? `push ${remote} ${targetBranch} failed`;
      if (push.diverged) {
        setMergeConflict(issue.id, {
          kind: 'push',
          target_branch: targetBranch,
          remote,
          reason,
          detected_at: new Date().toISOString(),
        });
        appendEvent({
          issue_id: issue.id,
          kind: 'conflict.detected',
          level: 'warn',
          message: `git conflict — ${remote}/${targetBranch} has diverged; reconcile needed before pushing`,
          data: { kind: 'push', remote, reason },
        });
      }
      appendEvent({
        issue_id: issue.id,
        kind: 'approve.failed',
        level: 'error',
        message: `approved merge landed locally but push to ${remote}/${targetBranch} failed: ${reason}`,
        data: { base: targetBranch, remote, commit: merge.commit, pushed: false, reason, diverged: push.diverged === true },
      });
      return { status: 409, body: { ok: false, reason, target_branch: targetBranch, conflict: push.diverged ? { kind: 'push' } : undefined } };
    }
    pushed = push.pushed;
  }

  // Success: clear any stale git-conflict decoration, clean up, mark done.
  clearMergeConflict(issue.id);
  await cleanupIssueResources(issue, { forceBranch: false, reason: 'approved' });
  if (opts.setDefaultBranch) updateProject(project.id, { default_branch: targetBranch });
  updateIssue(issue.id, { status: 'done', branch_name: null, worktree_path: null, base_branch: targetBranch });
  appendEvent({
    issue_id: issue.id,
    kind: 'approve.merged',
    message: merge.resolved_conflicts
      ? `approved — resolved conflicts and merged into ${targetBranch} (${merge.commit ?? '?'})`
      : `approved — merged into ${targetBranch} (${merge.commit ?? '?'})${pushed ? ` and pushed to ${remote}` : ''} and marked done`,
    data: {
      base: targetBranch,
      commit: merge.commit,
      created_branch: opts.createdBranch,
      set_default_branch: opts.setDefaultBranch,
      resolved_conflicts: merge.resolved_conflicts === true,
      conflicted_files: merge.conflicted_files ?? [],
      pushed,
      remote: pushed ? remote : undefined,
    },
  });
  return { status: 200, body: { ok: true, commit: merge.commit, target_branch: targetBranch, pushed, remote: pushed ? remote : undefined } };
}

function mergeOptionsForApproval(
  issue: Issue,
  project: NonNullable<ReturnType<typeof getProject>>,
  projectConfig: ReturnType<typeof mergeProjectConfigs>,
  workflow: ReturnType<typeof loadWorkflow>,
): MergeAgentBranchOptions {
  return {
    resolver: async (input) => resolveMergeConflicts(issue, project, projectConfig, workflow, input),
    verify: projectConfig.verification.commands.length
      ? async (checkoutPath) => verifyIntegratedMerge(issue.id, checkoutPath, projectConfig.verification.commands)
      : undefined,
  };
}

async function resolveMergeConflicts(
  issue: Issue,
  project: NonNullable<ReturnType<typeof getProject>>,
  projectConfig: ReturnType<typeof mergeProjectConfigs>,
  workflow: ReturnType<typeof loadWorkflow>,
  input: MergeConflictResolverInput,
) {
  appendEvent({
    issue_id: issue.id,
    kind: 'approve.conflict',
    level: 'warn',
    message: `merge conflict in ${input.conflictedFiles.join(', ')}`,
    data: { base: input.base, branch: input.branch, files: input.conflictedFiles, merge_output: input.mergeOutput },
  });

  const engineConfig = readEngineConfig();
  const result = await runClaudeCode({
    agent: 'claude', // this resolver always drives the Claude CLI directly
    cwd: input.checkoutPath,
    prompt: buildConflictPrompt(issue, project, input),
    systemPrompt: 'You are Symphony conflict-resolution automation. Resolve the merge conflict completely, do not commit, and never ask the user questions.',
    model: workflow?.model || project.model?.trim() || engineConfig.model,
    permissionMode: workflow?.permission_mode ?? projectConfig.agent.permission_mode ?? engineConfig.permission_mode,
    maxTurns:
      workflow?.max_turns_by_phase?.implement ??
      workflow?.max_turns ??
      projectConfig.agent.max_turns_by_phase?.implement ??
      projectConfig.agent.max_turns ??
      engineConfig.max_turns,
    timeoutMs: engineConfig.phase_timeout_ms,
    cliPath: engineConfig.cli_path,
  }, (event) => persistApproveAgentEvent(issue.id, event));

  if (!result.ok) {
    appendEvent({
      issue_id: issue.id,
      kind: 'approve.conflict_resolution_failed',
      level: 'error',
      message: result.error ?? 'conflict resolver failed',
      data: { files: input.conflictedFiles, session_id: result.sessionId, report: result.text },
    });
    return { ok: false, reason: result.error ?? 'conflict resolver failed', report: result.text };
  }

  appendEvent({
    issue_id: issue.id,
    kind: 'approve.conflict_resolved',
    message: `conflicts resolved in ${input.conflictedFiles.join(', ')}`,
    data: { files: input.conflictedFiles, session_id: result.sessionId, report: result.text },
  });
  return { ok: true, report: result.text };
}

function persistApproveAgentEvent(issueId: string, event: AgentEvent): void {
  if (event.type === 'text') return;
  if (event.type === 'usage') {
    appendEvent({ issue_id: issueId, kind: 'approve.agent_usage', level: 'debug', message: `${event.usage.total_tokens} tokens`, data: event.usage });
  } else if (event.type === 'init') {
    appendEvent({ issue_id: issueId, kind: 'approve.agent_init', message: `conflict resolver session ${event.sessionId.slice(0, 8)} (${event.model})`, data: event });
  } else if (event.type === 'tool_use') {
    appendEvent({
      issue_id: issueId,
      kind: 'approve.agent_tool',
      message: `resolver: ${event.name} ${JSON.stringify(event.input ?? {}).slice(0, 200)}`,
      data: { name: event.name },
    });
  } else if (event.type === 'tool_result') {
    appendEvent({ issue_id: issueId, kind: 'approve.agent_tool_result', level: 'debug', message: event.text.slice(0, 300) });
  } else if (event.type === 'error') {
    appendEvent({ issue_id: issueId, kind: 'approve.agent_error', level: 'error', message: event.message });
  }
}

async function verifyIntegratedMerge(
  issueId: string,
  checkoutPath: string,
  commands: ReturnType<typeof mergeProjectConfigs>['verification']['commands'],
) {
  appendEvent({ issue_id: issueId, kind: 'approve.verification_start', message: 'verifying integrated merge' });
  const verification = await runVerificationCommands(checkoutPath, commands);
  for (const command of verification.commands) {
    appendEvent({
      issue_id: issueId,
      kind: command.ok ? 'approve.verification_command_passed' : 'approve.verification_command_failed',
      level: command.ok ? 'info' : 'error',
      message: `${command.command} ${command.ok ? 'passed' : 'failed'} (${command.duration_ms}ms)`,
      data: command,
    });
  }
  if (!verification.ok) {
    appendEvent({ issue_id: issueId, kind: 'approve.verification_failed', level: 'error', message: verification.summary, data: verification });
    return { ok: false, reason: verification.summary };
  }
  appendEvent({ issue_id: issueId, kind: 'approve.verification_passed', message: verification.summary, data: verification });
  return { ok: true };
}

// SYM-29: agent-backed resolution for an approval that couldn't be integrated. Guarded on a parked
// (review) issue that carries a merge_conflict decoration. Re-runs the SAME merge (idempotent —
// "already up to date" when the branch already merged) and then reconciles the diverged remote via
// the agent-backed reconcileAndPushBase, finalizing (done + clears the marker) exactly like approve.
// On failure it keeps/refreshes the marker and returns 409 so the badge + button stay put.
issueRoutes.post('/:id/resolve-conflict', async (c) => {
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ ok: false, reason: 'not found' }, 404);
  if (issue.status !== 'review') {
    return c.json({ ok: false, reason: `issue is ${issue.status}, not awaiting review` }, 409);
  }
  if (!issue.merge_conflict) {
    return c.json({ ok: false, reason: 'no recorded git conflict to resolve' }, 409);
  }
  const project = getProject(issue.project_id);
  if (!project?.repo_path || !issue.branch_name || !issue.base_branch) {
    return c.json({ ok: false, reason: 'missing repo path or branch info — resolve manually' }, 400);
  }

  const workflow = loadWorkflow(project.repo_path);
  const projectConfig = mergeProjectConfigs(project.config, workflow?.config);
  const targetBranch = issue.merge_conflict.target_branch || issue.base_branch;

  appendEvent({ issue_id: issue.id, kind: 'conflict.resolve_started', message: `resolving git conflict (${issue.merge_conflict.kind}) on ${targetBranch}`, data: issue.merge_conflict });
  const outcome = await finalizeDirectMerge(issue, project, projectConfig, workflow, {
    targetBranch,
    setDefaultBranch: false,
    createdBranch: false,
    // Reuse the approval resolver/verify wiring; reconcileAndPushBase only invokes the agent when the
    // remote reconcile actually conflicts (a clean divergence merges silently and pushes).
    pushBase: (remote, branch) =>
      reconcileAndPushBase(
        project.repo_path!,
        remote,
        branch,
        `Reconcile ${remote}/${branch} into ${branch} for ${issue.key}`,
        mergeOptionsForApproval(issue, project, projectConfig, workflow),
      ),
  });
  if (outcome.status === 200) {
    appendEvent({ issue_id: issue.id, kind: 'conflict.resolved', message: `git conflict resolved — merged into ${targetBranch} and marked done`, data: { target_branch: targetBranch } });
  }
  return c.json(outcome.body, outcome.status);
});

// Request changes at the review gate → start a new revision round (loop engineering). Records the
// human feedback, bumps the issue's round, returns it to 'todo', and re-dispatches plan→implement→qa
// on the SAME branch/worktree (no cleanup — round N builds on round N-1's commits). The round-scoped
// run queries make the re-dispatch re-run every phase cold instead of skipping completed ones.
issueRoutes.post('/:id/request-changes', async (c) => {
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ ok: false, reason: 'not found' }, 404);
  if (issue.status !== 'review') {
    return c.json({ ok: false, reason: `issue is ${issue.status}, not awaiting review` }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as { feedback?: unknown };
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
  if (!feedback) return c.json({ ok: false, reason: 'feedback is required' }, 400);

  const nextRound = issue.round + 1;
  addRevision(issue.id, nextRound, feedback);
  setRound(issue.id, nextRound);
  clearMergeConflict(issue.id); // SYM-29: any prior approval conflict is stale once the branch is rebuilt
  setStatus(issue.id, 'todo'); // active status so the re-dispatch (or auto poll) picks it up
  appendEvent({
    issue_id: issue.id,
    kind: 'review.changes_requested',
    message: `changes requested — starting round ${nextRound}`,
    data: { round: nextRound, feedback: feedback.slice(0, 500) },
  });
  const dispatch = getOrchestrator().runNow(issue.id);
  return c.json({ ok: true, round: nextRound, dispatched: dispatch.ok, reason: dispatch.reason }, 202);
});

/** Keep only non-empty string ids from an untrusted attachment_ids payload (SYM-35). */
function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

async function cleanupIssueResources(
  issue: Issue,
  opts: { forceBranch: boolean; reason: 'approved' | 'cancelled' | 'deleted' },
): Promise<void> {
  stopPreview(issue.id);
  const project = getProject(issue.project_id);
  if (!project?.repo_path) return;
  if (issue.worktree_path) await removeWorktree(project.repo_path, issue.worktree_path);
  if (issue.branch_name) {
    const result = await deleteBranch(project.repo_path, issue.branch_name, { force: opts.forceBranch });
    if (!result.ok && opts.reason !== 'deleted') {
      appendEvent({
        issue_id: issue.id,
        kind: 'cleanup.branch_failed',
        level: 'warn',
        message: result.reason ?? `could not delete branch ${issue.branch_name}`,
        data: { branch: issue.branch_name, force: opts.forceBranch, reason: opts.reason },
      });
    }
  }
  if (opts.reason !== 'deleted') {
    appendEvent({
      issue_id: issue.id,
      kind: 'cleanup.done',
      message: `cleaned up story resources (${opts.reason})`,
      data: { branch: issue.branch_name, worktree_path: issue.worktree_path },
    });
  }
}

// Manual "Run" button — dispatch this issue now regardless of auto/manual mode.
issueRoutes.post('/:id/run', (c) => {
  const result = getOrchestrator().runNow(c.req.param('id'));
  return c.json(result, result.ok ? 202 : 409);
});

// ── Preview server (launch the project from the issue's worktree) ──
issueRoutes.get('/:id/preview', (c) => c.json(getPreview(c.req.param('id'))));

issueRoutes.post('/:id/preview', async (c) => {
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ running: false, error: 'not found' }, 404);
  if (!issue.worktree_path || !fs.existsSync(issue.worktree_path)) {
    return c.json({ running: false, error: 'no worktree to preview — run the issue first' }, 409);
  }
  const project = getProject(issue.project_id);
  const command = project?.preview_command || DEFAULT_PREVIEW_COMMAND;
  const status = await startPreview(issue.id, issue.worktree_path, command);
  if (status.running) {
    appendEvent({ issue_id: issue.id, kind: 'preview.start', message: `preview at ${status.url} (${status.command})` });
  }
  return c.json(status);
});

issueRoutes.delete('/:id/preview', (c) => {
  const stopped = stopPreview(c.req.param('id'));
  if (stopped) appendEvent({ issue_id: c.req.param('id'), kind: 'preview.stop', message: 'preview stopped' });
  return c.json({ running: false, stopped });
});
