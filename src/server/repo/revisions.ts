import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { IssueRevision } from '../../shared/types';

interface RevisionRow {
  id: string;
  issue_id: string;
  round: number;
  feedback: string;
  created_at: string;
}

const mapRow = (r: RevisionRow): IssueRevision => ({ ...r });

/** Record the "request changes" feedback that kicks off a new round (>= 2) for an issue. */
export function addRevision(issueId: string, round: number, feedback: string): IssueRevision {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO issue_revisions (id, issue_id, round, feedback) VALUES (?, ?, ?, ?)`,
    )
    .run(id, issueId, round, feedback);
  return getRevision(issueId, round)!;
}

/** The feedback that started a given round, or null (round 1 has no revision). */
export function getRevision(issueId: string, round: number): IssueRevision | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM issue_revisions WHERE issue_id = ? AND round = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(issueId, round) as RevisionRow | undefined;
  return row ? mapRow(row) : null;
}

/** All revisions for an issue, newest round first (for the detail history panel). */
export function listRevisions(issueId: string): IssueRevision[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM issue_revisions WHERE issue_id = ? ORDER BY round DESC, created_at DESC`,
    )
    .all(issueId) as unknown as RevisionRow[];
  return rows.map(mapRow);
}
