import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { ProjectNote } from '../../shared/types';

// Notes are the project's plain-text long-term memory: one short paragraph per completed issue,
// injected into later prompts (see core/prompt.ts). Caps keep that injection cheap.
const MAX_NOTE_CHARS = 500;

/**
 * Distill an implement-phase report into a one-paragraph note. The implement prompt asks the
 * agent to END with a summary paragraph, so the last non-empty paragraph carries the signal.
 */
export function noteFromReport(report: string): string {
  const paragraphs = report
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const summary = paragraphs[paragraphs.length - 1] ?? '';
  const reusable = paragraphs.find((p) => /reusable environment notes?:/i.test(p));
  const parts = [summary];
  if (reusable && reusable !== summary) parts.push(reusable);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** Upsert the per-issue learning note (re-running an issue replaces its previous note). */
export function recordIssueNote(projectId: string, issueId: string, content: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM project_notes WHERE issue_id = ?`).run(issueId);
  db.prepare(`INSERT INTO project_notes (id, project_id, issue_id, content) VALUES (?, ?, ?, ?)`)
    .run(newId(), projectId, issueId, content.slice(0, MAX_NOTE_CHARS));
}

/** Most recent notes for a project, newest first. */
export function listRecentNotes(projectId: string, limit = 5): ProjectNote[] {
  return getDb()
    .prepare(
      `SELECT * FROM project_notes WHERE project_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(projectId, limit) as unknown as ProjectNote[];
}
