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
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  num_turns: number;
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

export function finishRun(id: string, status: RunStatus, error?: string | null): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, error = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(status, error ?? null, id);
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

/** Runs left dangling (status='running') from a previous process — used by restart recovery. */
export function listDanglingRuns(): Run[] {
  const rows = getDb()
    .prepare(`SELECT * FROM runs WHERE status = 'running'`)
    .all() as unknown as RunRow[];
  return rows.map(mapRow);
}
