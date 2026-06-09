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
