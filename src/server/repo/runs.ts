import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type {
  IssueStatus,
  IssueType,
  OpsHistoryRow,
  Run,
  RunPhase,
  RunStatus,
} from '../../shared/types';

interface RunRow {
  id: string;
  issue_id: string;
  attempt: number;
  round: number;
  phase: string;
  status: string;
  session_id: string | null;
  error: string | null;
  report: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  num_turns: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  started_at: string;
  ended_at: string | null;
}

const mapRow = (r: RunRow): Run => ({
  ...r,
  phase: r.phase as RunPhase,
  status: r.status as RunStatus,
});

export function createRun(issueId: string, phase: RunPhase, attempt: number, round = 1): Run {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO runs (id, issue_id, attempt, round, phase, status) VALUES (?, ?, ?, ?, ?, 'running')`,
    )
    .run(id, issueId, attempt, round, phase);
  return getRun(id)!;
}

export function getRun(id: string): Run | null {
  const row = getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | RunRow
    | undefined;
  return row ? mapRow(row) : null;
}

export function listRuns(issueId: string): Run[] {
  const rows = getDb()
    .prepare(`SELECT * FROM runs WHERE issue_id = ? ORDER BY started_at DESC, rowid DESC`)
    .all(issueId) as unknown as RunRow[];
  return rows.map(mapRow);
}

export interface RunUsage {
  session_id?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  num_turns?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export function updateRunUsage(id: string, usage: RunUsage): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(usage)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return;
  params.push(id);
  getDb()
    .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(params as never[]));
}

export function finishRun(
  id: string,
  status: RunStatus,
  error?: string | null,
  report?: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, error = ?, report = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(status, error ?? null, report ?? null, id);
}

/** Aggregate token usage across all runs (for the orchestrator snapshot). */
export function sumTokens(): { input_tokens: number; output_tokens: number; total_tokens: number } {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM runs`,
    )
    .get() as { input_tokens: number; output_tokens: number; total_tokens: number };
  return row;
}

/**
 * The most recent failed run's phase + error for an issue — fed into retry prompts. Scoped to the
 * current round so a fresh revision round doesn't inherit a stale failure from an earlier round.
 */
export function lastFailure(issueId: string, round = 1): { phase: RunPhase; error: string } | null {
  const row = getDb()
    .prepare(
      `SELECT phase, error FROM runs
       WHERE issue_id = ? AND round = ? AND status IN ('failed', 'timeout', 'stalled') AND error IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, round) as { phase: string; error: string } | undefined;
  return row ? { phase: row.phase as RunPhase, error: row.error } : null;
}

/** Latest recorded CLI session for an issue+phase in a round — lets a retry resume instead of cold-start. */
export function lastSessionId(issueId: string, phase: RunPhase, round = 1): string | null {
  const row = getDb()
    .prepare(
      `SELECT session_id FROM runs
       WHERE issue_id = ? AND phase = ? AND round = ? AND session_id IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, phase, round) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

/**
 * Latest run for an issue+phase in a round, regardless of status. Round-scoping is what lets a new
 * revision round re-run plan→implement→qa cold instead of skipping phases completed in a prior round.
 */
export function latestRun(issueId: string, phase: RunPhase, round = 1): Run | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM runs
       WHERE issue_id = ? AND phase = ? AND round = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, phase, round) as RunRow | undefined;
  return row ? mapRow(row) : null;
}

/** Latest successful run for an issue+phase in a round, used to resume pipelines after process restarts. */
export function latestSuccessfulRun(issueId: string, phase: RunPhase, round = 1): Run | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM runs
       WHERE issue_id = ? AND phase = ? AND round = ? AND status = 'succeeded'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, phase, round) as RunRow | undefined;
  return row ? mapRow(row) : null;
}

interface HistoryRow {
  issue_id: string;
  issue_key: string;
  title: string;
  type: string;
  status: string;
  project_id: string;
  project_key: string;
  run_count: number;
  attempts: number;
  total_tokens: number;
  num_turns: number;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
  last_status: string | null;
  last_phase: string | null;
}

/**
 * Per-issue run history for the Ops page (§ observability). This is a runs aggregate that
 * happens to join issues + projects for display — it lives here, rather than splitting the repo's
 * one-file-per-table convention, for the same reason sumTokens() does: the grain is "runs".
 * One row per issue with >=1 run, summing tokens/turns and exposing the latest run's phase/status
 * via correlated subqueries. Cancelled issues are included even with zero runs (LEFT JOIN +
 * `OR i.status = 'cancelled'`) so the only UI entry point for never-run cancelled issues stays
 * complete; for those rows COUNT/SUM fall back to 0 and last_status/last_phase are NULL. Bounded
 * to 500 rows, most-recently-active first — never an unbounded list. `projectId`, when given,
 * scopes the result to a single project.
 */
export function listIssueHistory(projectId?: string): OpsHistoryRow[] {
  const rows = getDb()
    .prepare(
      `SELECT i.id AS issue_id, i.key AS issue_key, i.title, i.type, i.status,
              i.project_id, p.key AS project_key,
              COUNT(r.id) AS run_count,
              COALESCE(MAX(r.attempt), 0) AS attempts,
              COALESCE(SUM(r.total_tokens), 0) AS total_tokens,
              COALESCE(SUM(r.num_turns), 0) AS num_turns,
              MIN(r.started_at) AS started_at,
              MAX(r.ended_at) AS ended_at,
              i.updated_at,
              (SELECT status FROM runs WHERE issue_id = i.id ORDER BY started_at DESC, rowid DESC LIMIT 1) AS last_status,
              (SELECT phase  FROM runs WHERE issue_id = i.id ORDER BY started_at DESC, rowid DESC LIMIT 1) AS last_phase
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN runs r ON r.issue_id = i.id
       WHERE (r.id IS NOT NULL OR i.status = 'cancelled')${projectId ? ' AND i.project_id = ?' : ''}
       GROUP BY i.id
       ORDER BY COALESCE(MAX(r.ended_at), i.updated_at) DESC
       LIMIT 500`,
    )
    .all(...(projectId ? [projectId] : [])) as unknown as HistoryRow[];

  return rows.map((r) => ({
    issue_id: r.issue_id,
    issue_key: r.issue_key,
    title: r.title,
    type: r.type as IssueType,
    status: r.status as IssueStatus,
    project_id: r.project_id,
    project_key: r.project_key,
    run_count: r.run_count,
    attempts: r.attempts,
    total_tokens: r.total_tokens,
    num_turns: r.num_turns,
    started_at: r.started_at,
    ended_at: r.ended_at,
    updated_at: r.updated_at,
    last_status: r.last_status ? (r.last_status as RunStatus) : null,
    last_phase: r.last_phase ? (r.last_phase as RunPhase) : null,
  }));
}

/** Runs left dangling (status='running') from a previous process — used by restart recovery. */
export function listDanglingRuns(): Run[] {
  const rows = getDb()
    .prepare(`SELECT * FROM runs WHERE status = 'running'`)
    .all() as unknown as RunRow[];
  return rows.map(mapRow);
}
