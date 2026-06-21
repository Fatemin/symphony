import { Hono } from 'hono';
import {
  REVIEW_SCOPES,
  type AgentType,
  type Issue,
  type IssueMode,
  type IssueStatus,
  type Priority,
  type Project,
  type ReviewRun,
  type ReviewScope,
  type ReviewSeverity,
} from '../../../shared/types';
import type { EngineConfig } from '../../core/config';
import { buildReviewPrompt, parseReview } from '../../core/prompt';
import { loadWorkflow } from '../../core/workflow';
import { runAgent } from '../../agent/runAgent';
import type { AgentRunner } from '../../agent/types';
import { createIssue } from '../../repo/issues';
import { getOrchestrator } from '../../orchestrator/orchestrator';
import { getProject } from '../../repo/projects';
import {
  completeReviewRun,
  convertFinding,
  countRunningReviews,
  createReviewFinding,
  createReviewRun,
  deleteReviewRun,
  failReviewRun,
  getReviewFinding,
  getReviewRun,
  getReviewRunWithFindings,
  listReviewRunsWithFindings,
  setFindingStatus,
} from '../../repo/reviews';
import { getConfig } from '../../repo/settings';

// "Review" (SYM-51) is a standalone, READ-ONLY, agent-driven audit of a project — modeled on Ask, NOT
// the orchestrator pipeline. It runs against the project's live repo (no worktree) in 'plan' mode so
// the agent reads + reports but never edits/commits. Unlike Ask it is asynchronous: POST starts a
// background run (202) that completes regardless of the client, and its graded findings are persisted
// as draft "issue cards" the user can convert into real issues or dismiss.

export const reviewRoutes = new Hono();

/** Bound a review session: ample to read the repo, far below the build pipeline's caps (like Ask). */
const REVIEW_MAX_TURNS = 80;

// Test seam (mirrors localUsage.ts's `__reset` hook convention): production leaves this undefined so
// the POST handler's fire-and-forget execution uses the real multi-CLI `runAgent`. Offline tests set
// a fake runner here so POST /:id/reviews can exercise the 202 path WITHOUT ever spawning a real CLI.
// executeReviewRun still takes an explicit `runner` option, so its direct unit tests don't need this.
let backgroundRunner: AgentRunner | undefined;
export function __setReviewBackgroundRunner(runner: AgentRunner | undefined): void {
  backgroundRunner = runner;
}

/** Finding severity → the converted issue's priority (1 = urgent … 4 = low). */
const SEVERITY_PRIORITY: Record<ReviewSeverity, Priority> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

export interface ExecuteReviewOptions {
  /** Injected for tests; production uses the real multi-CLI dispatcher. */
  runner?: AgentRunner;
  config?: EngineConfig;
}

/**
 * Run one review batch end to end. This is the awaitable, NEVER-throwing core (tests call it
 * directly): it runs the agent, parses + persists the findings, and flips the run to `completed`
 * (or `failed` with the reason). A malformed/empty agent reply is non-fatal — parseReview yields an
 * empty findings list and the run still completes. Deliberately takes no AbortSignal: a review must
 * finish even if the client navigates away (mirrors the Ask SYM-48 invariant).
 */
export async function executeReviewRun(
  run: ReviewRun,
  project: Project,
  opts: ExecuteReviewOptions = {},
): Promise<ReviewRun> {
  const runner = opts.runner ?? runAgent;
  const config = opts.config ?? getConfig();
  try {
    if (!project.repo_path) {
      return failReviewRun(run.id, 'project has no repo_path — connect a repo before reviewing') ?? run;
    }
    const agent: AgentType = run.agent === 'codex' ? 'codex' : 'claude';
    const workflow = loadWorkflow(project.repo_path);
    const model =
      workflow?.model ||
      project.model?.trim() ||
      (agent === 'codex' ? config.codex_model : config.model);

    const result = await runner({
      agent,
      cwd: project.repo_path,
      prompt: buildReviewPrompt(project, run.scope),
      systemPrompt:
        'You are Symphony Review — analyze this project READ-ONLY. Never modify, create, or delete ' +
        'files, never commit, and never use interactive prompts.',
      model,
      permissionMode: 'plan', // read-only: the agent reads + reports, it does not edit
      maxTurns: Math.min(config.max_turns, REVIEW_MAX_TURNS),
      disableWorkflows: true, // review never needs the Workflow tool; stay default-off
      timeoutMs: config.phase_timeout_ms,
      cliPath: agent === 'codex' ? config.codex_cli_path : config.cli_path,
    });

    if (!result.ok) {
      return failReviewRun(run.id, result.error ?? 'review agent failed') ?? run;
    }

    const parsed = parseReview(result.text);
    // createReviewFinding assigns each per-run seq, so insertion order == report order.
    for (const f of parsed.findings) {
      createReviewFinding({
        review_run_id: run.id,
        project_id: project.id,
        category: f.category,
        type: f.type,
        title: f.title,
        description: f.description || null,
        acceptance_criteria: f.acceptance_criteria || null,
        severity: f.severity,
      });
    }
    return completeReviewRun(run.id, parsed.summary || null) ?? run;
  } catch (e) {
    return failReviewRun(run.id, e instanceof Error ? e.message : String(e)) ?? run;
  }
}

// Start a review batch. Validates the scope + repo, enforces one-concurrent-per-project, then kicks
// off the agent in the background and returns the `running` row immediately (202).
reviewRoutes.post('/:id/reviews', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!project.repo_path) {
    return c.json({ error: 'project has no repo_path — connect a repo before reviewing' }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown; agent?: unknown };
  const scope = REVIEW_SCOPES.includes(body.scope as ReviewScope) ? (body.scope as ReviewScope) : null;
  if (!scope) {
    return c.json({ error: `scope must be one of: ${REVIEW_SCOPES.join(', ')}` }, 400);
  }
  // One in-flight review per project — the background run is unbounded by the orchestrator's WIP
  // limit, so this is the only guard against piling up concurrent agent sessions on one repo.
  if (countRunningReviews(project.id) > 0) {
    return c.json({ error: 'a review is already running for this project' }, 409);
  }

  // Resolve the concrete agent now (so the row records which CLI ran), mirroring runProjectAsk's
  // precedence: request override → WORKFLOW.md → project → engine.
  const reqAgent = body.agent === 'codex' || body.agent === 'claude' ? body.agent : undefined;
  const config = getConfig();
  const workflow = loadWorkflow(project.repo_path);
  const rawAgent = reqAgent ?? workflow?.agent ?? project.agent ?? config.agent;
  const agent: AgentType = rawAgent === 'codex' ? 'codex' : 'claude';

  const run = createReviewRun({ project_id: project.id, scope, agent });
  // Fire-and-forget: the run completes in the background even if the client disconnects (no
  // AbortSignal). executeReviewRun never throws; the .catch is a final safety net so an unexpected
  // throw still parks the row as `failed` rather than leaving it stuck `running`. `backgroundRunner`
  // is undefined in production (⇒ real runAgent) and only set by offline tests.
  void executeReviewRun(run, project, { config, runner: backgroundRunner }).catch((e) =>
    failReviewRun(run.id, e instanceof Error ? e.message : String(e)),
  );
  return c.json(run, 202);
});

// Recent review batches (newest first) with their graded findings — the Review tab's payload.
reviewRoutes.get('/:id/reviews', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json(listReviewRunsWithFindings(project.id));
});

// Convert one draft finding into a real issue (feature/bug). Idempotent-guarded: a second convert of
// an already-converted finding is a 409 (it must not create a duplicate issue).
reviewRoutes.post('/:id/reviews/findings/:findingId/convert', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const finding = getReviewFinding(c.req.param('findingId'));
  if (!finding || finding.project_id !== project.id) return c.json({ error: 'not found' }, 404);
  if (finding.status === 'converted' && finding.issue_id) {
    return c.json({ error: 'finding already converted', issue_id: finding.issue_id }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
  // Default to Todo (the actionable column); 'backlog' parks it for later. No other status is allowed.
  const status: IssueStatus = body.status === 'backlog' ? 'backlog' : 'todo';

  const issue = createIssue({
    project_id: project.id,
    title: finding.title,
    type: finding.type,
    description: finding.description,
    acceptance_criteria: finding.acceptance_criteria,
    status,
    mode: 'manual',
    priority: SEVERITY_PRIORITY[finding.severity],
  });
  const updated = convertFinding(finding.id, issue.id);
  return c.json({ issue, finding: updated }, 201);
});

// Batch-convert a whole run's still-draft findings in one click (SYM-66). Defaults to mode='auto' so
// the created issues are immediately orchestrator-eligible and get worked through automatically (most
// critical first) — the feature's whole point. Route arity (4 segments) differs from the per-finding
// convert (5: /reviews/findings/:findingId/convert), so they never collide.
//
// Idempotency is structural: only `draft` findings are converted, and convertFinding flips them to
// `converted`, so a re-click finds nothing left and creates no duplicates. This makes the op safe to
// retry and lets it mop up any drafts a prior partial run missed.
reviewRoutes.post('/:id/reviews/:runId/convert', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const run = getReviewRunWithFindings(c.req.param('runId'));
  if (!run || run.project_id !== project.id) return c.json({ error: 'not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    status?: unknown;
    mode?: unknown;
    finding_ids?: unknown;
  };
  // AUTO + Todo by default (the feature): auto+todo issues match listAutoCandidates() and dispatch
  // promptly. A caller can still opt into manual triage (mode='manual') or parking (status='backlog').
  const status: IssueStatus = body.status === 'backlog' ? 'backlog' : 'todo';
  const mode: IssueMode = body.mode === 'manual' ? 'manual' : 'auto';
  // Optional allow-list: convert only the named findings (e.g. one severity group). Absent ⇒ all drafts.
  const filter = Array.isArray(body.finding_ids)
    ? new Set(body.finding_ids.filter((x): x is string => typeof x === 'string'))
    : null;

  const drafts = run.findings.filter((f) => f.status === 'draft' && (!filter || filter.has(f.id)));
  const issues: Issue[] = [];
  for (const f of drafts) {
    const issue = createIssue({
      project_id: project.id,
      title: f.title,
      type: f.type,
      description: f.description,
      acceptance_criteria: f.acceptance_criteria,
      status,
      mode,
      priority: SEVERITY_PRIORITY[f.severity],
    });
    convertFinding(f.id, issue.id);
    issues.push(issue);
  }
  // Wake the dispatch loop so the new auto issues start without waiting for the next poll (mirrors
  // issues.ts). Manual issues just sit on the board, so no kick is needed for them.
  if (mode === 'auto' && issues.length) void getOrchestrator().kick();
  return c.json({ issues, converted: issues.length }, 201);
});

// Toggle a finding between draft and dismissed. 'converted' is owned by the convert endpoint (it
// must create + link an issue), so it is rejected here.
reviewRoutes.patch('/:id/reviews/findings/:findingId', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const finding = getReviewFinding(c.req.param('findingId'));
  if (!finding || finding.project_id !== project.id) return c.json({ error: 'not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
  if (body.status !== 'draft' && body.status !== 'dismissed') {
    return c.json({ error: "status must be 'draft' or 'dismissed'" }, 400);
  }
  if (finding.status === 'converted') {
    return c.json({ error: 'a converted finding cannot change status' }, 409);
  }
  return c.json(setFindingStatus(finding.id, body.status));
});

// Delete a whole batch (cascades its findings). Converted issues are untouched — they live on the board.
reviewRoutes.delete('/:id/reviews/:runId', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const run = getReviewRun(c.req.param('runId'));
  if (run && run.project_id === project.id) deleteReviewRun(run.id);
  return c.body(null, 204);
});
