import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { Event, EventLevel } from '../../shared/types';

interface EventRow {
  rowid: number;
  id: string;
  issue_id: string | null;
  run_id: string | null;
  kind: string;
  level: string;
  message: string;
  data: string | null;
  created_at: string;
}

/** Events carry a monotonic `cursor` (the SQLite rowid) so streams can resume cleanly. */
export type EventWithCursor = Event & { cursor: number };

function mapRow(r: EventRow): EventWithCursor {
  let data: unknown = null;
  if (r.data != null) {
    try {
      data = JSON.parse(r.data);
    } catch {
      data = r.data;
    }
  }
  return {
    cursor: r.rowid,
    id: r.id,
    issue_id: r.issue_id,
    run_id: r.run_id,
    kind: r.kind,
    level: r.level as EventLevel,
    message: r.message,
    data,
    created_at: r.created_at,
  };
}

export interface AppendEventInput {
  issue_id?: string | null;
  run_id?: string | null;
  kind: string;
  level?: EventLevel;
  message: string;
  data?: unknown;
}

export function appendEvent(input: AppendEventInput): EventWithCursor {
  const id = newId();
  const info = getDb()
    .prepare(
      `INSERT INTO events (id, issue_id, run_id, kind, level, message, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.issue_id ?? null,
      input.run_id ?? null,
      input.kind,
      input.level ?? 'info',
      input.message,
      input.data === undefined ? null : JSON.stringify(input.data),
    );
  const row = getDb()
    .prepare(`SELECT rowid, * FROM events WHERE rowid = ?`)
    .get(info.lastInsertRowid as number) as unknown as EventRow;
  return mapRow(row);
}

export interface ListEventsQuery {
  issue_id?: string;
  run_id?: string;
  sinceCursor?: number;
  limit?: number;
}

/**
 * SYM-62: distinct skill slugs an issue invoked during a given round, harvested from that round's
 * `agent.tool` events (each `Skill` tool_use persists `data.skill` — see `phases/index.ts`). The
 * delivery sequencer uses this to append a "Skills used" tail to its summary. Reading the event log
 * (not in-memory state) keeps it durable across retries, where a fresh pipeline call skips
 * already-succeeded phases and would otherwise lose earlier-attempt skill use. Sorted for a stable,
 * deterministic ordering.
 */
export function listSkillsUsed(issueId: string, round: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT e.data AS data
         FROM events e
         JOIN runs r ON e.run_id = r.id
        WHERE e.issue_id = ? AND r.round = ? AND e.kind = 'agent.tool'`,
    )
    .all(issueId, round) as unknown as { data: string | null }[];
  const skills = new Set<string>();
  for (const row of rows) {
    if (row.data == null) continue;
    try {
      const parsed = JSON.parse(row.data) as { skill?: unknown };
      if (typeof parsed.skill === 'string' && parsed.skill.trim()) {
        skills.add(parsed.skill.trim());
      }
    } catch {
      // A malformed event payload is non-fatal — skip it (matches mapRow's tolerant parse).
    }
  }
  return [...skills].sort();
}

export function listEvents(query: ListEventsQuery = {}): EventWithCursor[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.issue_id) {
    where.push(`issue_id = ?`);
    params.push(query.issue_id);
  }
  if (query.run_id) {
    where.push(`run_id = ?`);
    params.push(query.run_id);
  }
  if (query.sinceCursor != null) {
    where.push(`rowid > ?`);
    params.push(query.sinceCursor);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(query.limit ?? 500, 2000);
  const rows = getDb()
    .prepare(`SELECT rowid, * FROM events ${clause} ORDER BY rowid ASC LIMIT ?`)
    .all(...params, limit) as unknown as EventRow[];
  return rows.map(mapRow);
}
