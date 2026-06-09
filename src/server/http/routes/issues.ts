import { Hono } from 'hono';
import {
  createIssue,
  deleteIssue,
  getIssue,
  isTerminal,
  listIssues,
  updateIssue,
} from '../../repo/issues';
import { getProject } from '../../repo/projects';
import { listTasks } from '../../repo/tasks';
import { listRuns } from '../../repo/runs';
import { listEvents } from '../../repo/events';
import { getBranchDiff } from '../../workspace/worktree';
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
    void getOrchestrator().kick();
  }
  return c.json(issue);
});

issueRoutes.delete('/:id', (c) => {
  deleteIssue(c.req.param('id'));
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

// Manual "Run" button — dispatch this issue now regardless of auto/manual mode.
issueRoutes.post('/:id/run', (c) => {
  const result = getOrchestrator().runNow(c.req.param('id'));
  return c.json(result, result.ok ? 202 : 409);
});
