import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { AskMessage, AskSuggestion } from '../../shared/types';

// Persisted "ask" history (SYM-12): one row per conversation turn, scoped to a project-day. The
// "day" is the server-local calendar date, so `date('now','localtime')` both stamps new turns and
// selects/clears today's — daily rollover needs no scheduler. All ask_messages SQL lives here.

/** Cap a stored turn so a runaway answer can't bloat the table or later prompt injection. */
const MAX_ASK_CHARS = 16_000;

/**
 * Append one turn to today's conversation for a project. A suggestion is persisted as JSON on the
 * actionable assistant turn (SYM-28) so the draft-issue card survives a conversation switch; user
 * turns and informational answers pass `null`.
 */
export function appendAskTurn(
  projectId: string,
  role: AskMessage['role'],
  content: string,
  suggestion: AskSuggestion | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO ask_messages (id, project_id, convo_date, role, content, suggestion)
       VALUES (?, ?, date('now','localtime'), ?, ?, ?)`,
    )
    .run(newId(), projectId, role, content.slice(0, MAX_ASK_CHARS), suggestion ? JSON.stringify(suggestion) : null);
}

/** The server-local calendar day, defined identically to the convo_date queries above. */
export function todaysAskDate(): string {
  const row = getDb().prepare(`SELECT date('now','localtime') AS d`).get() as { d: string };
  return row.d;
}

/** Today's conversation for a project, oldest turn first. */
export function listTodaysAskMessages(projectId: string): AskMessage[] {
  const rows = getDb()
    .prepare(
      // rowid is monotonic with insertion (the id PK is a random nanoid, so it can't order turns).
      `SELECT role, content, suggestion FROM ask_messages
       WHERE project_id = ? AND convo_date = date('now','localtime')
       ORDER BY rowid`,
    )
    .all(projectId) as Array<{ role: AskMessage['role']; content: string; suggestion: string | null }>;
  return rows.map((r) => ({ role: r.role, content: r.content, suggestion: parseSuggestion(r.suggestion) }));
}

/** Decode a stored suggestion; a malformed/legacy row degrades to no card rather than throwing. */
function parseSuggestion(raw: string | null): AskSuggestion | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AskSuggestion;
  } catch {
    return null;
  }
}

/** Reset today's conversation for a project (manual "new conversation"). */
export function resetTodaysAsk(projectId: string): void {
  getDb()
    .prepare(`DELETE FROM ask_messages WHERE project_id = ? AND convo_date = date('now','localtime')`)
    .run(projectId);
}
