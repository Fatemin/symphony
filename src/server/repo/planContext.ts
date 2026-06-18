import { getDb } from '../db/client';
import type { IssuePlanContext, PlanKeyFile } from '../../shared/types';

interface PlanContextRow {
  issue_id: string;
  notes: string | null;
  context: string | null;
  key_files: string;
  created_at: string;
  updated_at: string;
}

const MAX_TEXT = 4_000;
const MAX_KEY_FILES = 20;

function mapRow(row: PlanContextRow): IssuePlanContext {
  let keyFiles: PlanKeyFile[] = [];
  try {
    const parsed = JSON.parse(row.key_files);
    if (Array.isArray(parsed)) {
      keyFiles = normalizeKeyFiles(parsed);
    }
  } catch {
    /* keep [] */
  }
  return {
    issue_id: row.issue_id,
    notes: row.notes,
    context: row.context,
    key_files: keyFiles,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface PlanContextInput {
  notes?: string | null;
  context?: string | null;
  key_files?: PlanKeyFile[];
}

/** Persist the planner's transferable repository map for the later implement phase. */
export function savePlanContext(issueId: string, input: PlanContextInput): IssuePlanContext {
  const notes = cleanText(input.notes);
  const context = cleanText(input.context);
  const keyFiles = normalizeKeyFiles(input.key_files ?? []);

  getDb()
    .prepare(
      `INSERT INTO issue_plan_context (issue_id, notes, context, key_files)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         notes = excluded.notes,
         context = excluded.context,
         key_files = excluded.key_files,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(issueId, notes, context, JSON.stringify(keyFiles));

  return getPlanContext(issueId)!;
}

export function getPlanContext(issueId: string): IssuePlanContext | null {
  const row = getDb()
    .prepare(`SELECT * FROM issue_plan_context WHERE issue_id = ?`)
    .get(issueId) as PlanContextRow | undefined;
  return row ? mapRow(row) : null;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, MAX_TEXT) : null;
}

function normalizeKeyFiles(files: unknown[]): PlanKeyFile[] {
  return files
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      path: String(f.path ?? '').trim(),
      purpose: String(f.purpose ?? f.role ?? f.reason ?? '').trim(),
    }))
    .filter((f) => f.path.length > 0)
    .slice(0, MAX_KEY_FILES)
    .map((f) => ({ path: f.path.slice(0, 300), purpose: f.purpose.slice(0, 500) }));
}
