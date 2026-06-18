import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { Run, RunPhase, RunStatus } from '../../shared/types';

interface RunRow {
  id: string;
  issue_id: string;
  attempt: number;
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

export function createRun(issueId: string, phase: RunPhase, attempt: number): Run {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO runs (id, issue_id, attempt, phase, status) VALUES (?, ?, ?, ?, 'running')`,
    )
    .run(id, issueId, attempt, phase);
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

/** The most recent failed run's phase + error for an issue — fed into retry prompts. */
export function lastFailure(issueId: string): { phase: RunPhase; error: string } | null {
  const row = getDb()
    .prepare(
      `SELECT phase, error FROM runs
       WHERE issue_id = ? AND status IN ('failed', 'timeout', 'stalled') AND error IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId) as { phase: string; error: string } | undefined;
  return row ? { phase: row.phase as RunPhase, error: row.error } : null;
}

/** Latest recorded CLI session for an issue+phase — lets a retry resume instead of cold-start. */
export function lastSessionId(issueId: string, phase: RunPhase): string | null {
  const row = getDb()
    .prepare(
      `SELECT session_id FROM runs
       WHERE issue_id = ? AND phase = ? AND session_id IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, phase) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

/** Latest run for an issue+phase, regardless of status. */
export function latestRun(issueId: string, phase: RunPhase): Run | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM runs
       WHERE issue_id = ? AND phase = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, phase) as RunRow | undefined;
  return row ? mapRow(row) : null;
}

/** Latest successful run for an issue+phase, used to resume pipelines after process restarts. */
export function latestSuccessfulRun(issueId: string, phase: RunPhase): Run | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM runs
       WHERE issue_id = ? AND phase = ? AND status = 'succeeded'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, phase) as RunRow | undefined;
  return row ? mapRow(row) : null;
}

/** Runs left dangling (status='running') from a previous process — used by restart recovery. */
export function listDanglingRuns(): Run[] {
  const rows = getDb()
    .prepare(`SELECT * FROM runs WHERE status = 'running'`)
    .all() as unknown as RunRow[];
  return rows.map(mapRow);
}
