import fs from 'node:fs';
import { Hono } from 'hono';
import type { Issue } from '../../../shared/types';
import {
  createIssue,
  deleteIssue,
  getIssue,
  isTerminal,
  listIssues,
  updateIssue,
} from '../../repo/issues';
import { mergeProjectConfigs } from '../../core/projectConfig';
import { loadWorkflow } from '../../core/workflow';
import { getProject, updateProject } from '../../repo/projects';
import { listTasks } from '../../repo/tasks';
import { listRuns } from '../../repo/runs';
import { appendEvent, listEvents } from '../../repo/events';
import { promoteViaPullRequest } from '../../workspace/promotion';
import { deleteBranch, ensureBranch, getBranchDiff, mergeAgentBranch, pushBranch, removeWorktree } from '../../workspace/worktree';
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
  return c.json(createIssue(body), 201);
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
  });
});

issueRoutes.patch('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const before = getIssue(c.req.param('id'));
  if (!before) return c.json({ error: 'not found' }, 404);
  const issue = updateIssue(before.id, body);
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
    appendEvent({
      issue_id: issue.id,
      kind: promotion.merged ? 'approve.pr_merged' : 'approve.pr_opened',
      message: promotion.merged
        ? `approved — PR merged by platform checks (${promotion.pr_url})`
        : `approved — opened PR against ${baseBranch}: ${promotion.pr_url}`,
      data: { base: baseBranch, branch: issue.branch_name, pr_url: promotion.pr_url, merged: promotion.merged, created_branch: ensured.created, set_default_branch: setDefaultBranch },
    });
    if (promotion.merged) {
      await cleanupIssueResources(issue, { forceBranch: false, reason: 'approved' });
      updateIssue(issue.id, { status: 'done', branch_name: null, worktree_path: null });
    }
    return c.json({ ok: true, pr_url: promotion.pr_url, merged: promotion.merged ?? false, target_branch: baseBranch });
  }

  const merge = await mergeAgentBranch(
    project.repo_path,
    targetBranch,
    issue.branch_name,
    `Merge ${issue.key}: ${issue.title}`,
  );
  if (!merge.ok) {
    appendEvent({ issue_id: issue.id, kind: 'approve.failed', level: 'error', message: merge.reason ?? 'merge failed' });
    return c.json(merge, 409);
  }

  await cleanupIssueResources(issue, { forceBranch: false, reason: 'approved' });
  if (setDefaultBranch) updateProject(project.id, { default_branch: targetBranch });
  updateIssue(issue.id, { status: 'done', branch_name: null, worktree_path: null, base_branch: targetBranch });
  appendEvent({
    issue_id: issue.id,
    kind: 'approve.merged',
    message: `approved — merged into ${targetBranch} (${merge.commit ?? '?'}) and marked done`,
    data: { base: targetBranch, commit: merge.commit, created_branch: ensured.created, set_default_branch: setDefaultBranch },
  });
  return c.json({ ok: true, commit: merge.commit, target_branch: targetBranch });
});

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
