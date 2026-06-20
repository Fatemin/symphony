import { getDb } from '../db/client';
import { newId } from '../core/keys';
import {
  REVIEW_CATEGORIES,
  REVIEW_SCOPES,
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
  type AgentType,
  type ReviewCategory,
  type ReviewFinding,
  type ReviewFindingStatus,
  type ReviewRun,
  type ReviewRunWithFindings,
  type ReviewScope,
  type ReviewSeverity,
  type ReviewStatus,
} from '../../shared/types';

// All review SQL lives here (SYM-51). A review is a standalone, READ-ONLY agent run (modeled on Ask,
// NOT the orchestrator pipeline): review_runs holds one row per batch, review_findings the graded
// draft "issue cards" within it. mapRow is the defensive boundary — every enum (scope/status/
// severity/category/finding-status/type) is whitelisted on read so a stale or garbage value reads
// back as a sensible default rather than leaking out untyped (mirrors issues.ts#mapRow's THINKING_EFFORTS guard).

interface ReviewRunRow {
  id: string;
  project_id: string;
  scope: string;
  status: string;
  agent: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ReviewFindingRow {
  id: string;
  review_run_id: string;
  project_id: string;
  seq: number;
  category: string;
  type: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  severity: string;
  status: string;
  issue_id: string | null;
  issue_key: string | null; // from the LEFT JOIN onto issues
  created_at: string;
  updated_at: string;
}

function whitelist<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function mapRunRow(r: ReviewRunRow): ReviewRun {
  return {
    id: r.id,
    project_id: r.project_id,
    scope: whitelist<ReviewScope>(r.scope, REVIEW_SCOPES, 'all'),
    status: whitelist<ReviewStatus>(r.status, REVIEW_STATUSES, 'completed'),
    agent: r.agent === 'codex' || r.agent === 'claude' ? (r.agent as AgentType) : null,
    summary: r.summary,
    error: r.error,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function mapFindingRow(r: ReviewFindingRow): ReviewFinding {
  return {
    id: r.id,
    review_run_id: r.review_run_id,
    project_id: r.project_id,
    seq: r.seq,
    category: whitelist<ReviewCategory>(r.category, REVIEW_CATEGORIES, 'code'),
    type: r.type === 'bug' ? 'bug' : 'feature',
    title: r.title,
    description: r.description,
    acceptance_criteria: r.acceptance_criteria,
    severity: whitelist<ReviewSeverity>(r.severity, REVIEW_SEVERITIES, 'medium'),
    status:
      r.status === 'converted' || r.status === 'dismissed'
        ? (r.status as ReviewFindingStatus)
        : 'draft',
    issue_id: r.issue_id,
    issue_key: r.issue_key,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Findings always carry the converted issue's key (LEFT JOIN, null when not converted / deleted).
const FINDING_SELECT = /* sql */ `
  SELECT f.*, i.key AS issue_key
  FROM review_findings f
  LEFT JOIN issues i ON i.id = f.issue_id
`;

// ── runs ───────────────────────────────────────────────────────────────────

export interface CreateReviewRunInput {
  project_id: string;
  scope: ReviewScope;
  /** Concrete agent resolved by the route before insert; persisted so the UI shows which CLI ran. */
  agent: AgentType | null;
}

/** Insert a fresh `running` batch. */
export function createReviewRun(input: CreateReviewRunInput): ReviewRun {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO review_runs (id, project_id, scope, status, agent)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run(id, input.project_id, input.scope, input.agent);
  return getReviewRun(id)!;
}

export function getReviewRun(id: string): ReviewRun | null {
  const row = getDb().prepare(`SELECT * FROM review_runs WHERE id = ?`).get(id) as
    | ReviewRunRow
    | undefined;
  return row ? mapRunRow(row) : null;
}

export function getReviewRunWithFindings(id: string): ReviewRunWithFindings | null {
  const run = getReviewRun(id);
  if (!run) return null;
  return { ...run, findings: listFindingsByRun(id) };
}

/** Recent batches for a project (newest first), each with its findings — the Review tab's payload. */
export function listReviewRunsWithFindings(projectId: string, limit = 20): ReviewRunWithFindings[] {
  const runs = (
    getDb()
      .prepare(
        `SELECT * FROM review_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as ReviewRunRow[]
  ).map(mapRunRow);
  if (runs.length === 0) return [];
  // One query for all findings of the listed runs, grouped in memory (avoids N+1).
  const ids = runs.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(', ');
  const findings = (
    getDb()
      .prepare(`${FINDING_SELECT} WHERE f.review_run_id IN (${placeholders}) ORDER BY f.seq`)
      .all(...ids) as unknown as ReviewFindingRow[]
  ).map(mapFindingRow);
  const byRun = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const list = byRun.get(f.review_run_id) ?? [];
    list.push(f);
    byRun.set(f.review_run_id, list);
  }
  return runs.map((run) => ({ ...run, findings: byRun.get(run.id) ?? [] }));
}

/** Number of in-flight batches for a project — the one-concurrent-per-project guard. */
export function countRunningReviews(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM review_runs WHERE project_id = ? AND status = 'running'`)
    .get(projectId) as { n: number };
  return row.n;
}

/** Mark a batch completed with its summary. */
export function completeReviewRun(id: string, summary: string | null): ReviewRun | null {
  getDb()
    .prepare(
      `UPDATE review_runs
       SET status = 'completed', summary = ?, error = NULL,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(summary, id);
  return getReviewRun(id);
}

/** Mark a batch failed with a reason (agent error / exception / boot reconciliation). */
export function failReviewRun(id: string, error: string): ReviewRun | null {
  getDb()
    .prepare(
      `UPDATE review_runs
       SET status = 'failed', error = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(error.slice(0, 2_000), id);
  return getReviewRun(id);
}

/**
 * Fail any batch left `running` at boot (SYM-51). A review run is a background, non-orchestrated
 * promise: a server restart while one is in-flight would otherwise leave its row stuck `running`
 * forever (and block new runs via the concurrency guard). Idempotent — runs once at startup.
 */
export function failInterruptedReviewRuns(): number {
  const res = getDb()
    .prepare(
      `UPDATE review_runs
       SET status = 'failed', error = 'interrupted by a server restart',
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'running'`,
    )
    .run();
  return Number(res.changes ?? 0);
}

/** Delete a batch (cascades its findings; converted issues are untouched). */
export function deleteReviewRun(id: string): void {
  getDb().prepare(`DELETE FROM review_runs WHERE id = ?`).run(id);
}

// ── findings ─────────────────────────────────────────────────────────────

export interface CreateReviewFindingInput {
  review_run_id: string;
  project_id: string;
  category: ReviewCategory;
  type: 'feature' | 'bug';
  title: string;
  description?: string | null;
  acceptance_criteria?: string | null;
  severity: ReviewSeverity;
}

/** Insert one finding, assigning the next per-run seq. */
export function createReviewFinding(input: CreateReviewFindingInput): ReviewFinding {
  const db = getDb();
  const id = newId();
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS max FROM review_findings WHERE review_run_id = ?`)
    .get(input.review_run_id) as { max: number };
  const seq = row.max + 1;
  db.prepare(
    `INSERT INTO review_findings
       (id, review_run_id, project_id, seq, category, type, title, description, acceptance_criteria, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.review_run_id,
    input.project_id,
    seq,
    input.category,
    input.type,
    input.title,
    input.description ?? null,
    input.acceptance_criteria ?? null,
    input.severity,
  );
  return getReviewFinding(id)!;
}

export function getReviewFinding(id: string): ReviewFinding | null {
  const row = getDb().prepare(`${FINDING_SELECT} WHERE f.id = ?`).get(id) as
    | ReviewFindingRow
    | undefined;
  return row ? mapFindingRow(row) : null;
}

export function listFindingsByRun(runId: string): ReviewFinding[] {
  const rows = getDb()
    .prepare(`${FINDING_SELECT} WHERE f.review_run_id = ? ORDER BY f.seq`)
    .all(runId) as unknown as ReviewFindingRow[];
  return rows.map(mapFindingRow);
}

/** Link a finding to the issue it was converted into (status → 'converted'). */
export function convertFinding(findingId: string, issueId: string): ReviewFinding | null {
  getDb()
    .prepare(
      `UPDATE review_findings
       SET status = 'converted', issue_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(issueId, findingId);
  return getReviewFinding(findingId);
}

/** Set a finding's status (e.g. dismiss a draft, or restore a dismissed one). */
export function setFindingStatus(findingId: string, status: ReviewFindingStatus): ReviewFinding | null {
  getDb()
    .prepare(
      `UPDATE review_findings
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(status, findingId);
  return getReviewFinding(findingId);
}
