import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client';
import { newId } from '../core/keys';
import { ATTACHMENTS_DIR } from '../env';
import type { PromptAttachment } from '../core/prompt';
import type { Attachment } from '../../shared/types';

// All attachment SQL + blob I/O lives here (SYM-35). Blobs are stored under ATTACHMENTS_DIR at
// `<id>/<sanitized-filename>`; the DB row keeps that relative storage_path plus display metadata.
// Two safety invariants mirror the worktree §9.5 rule:
//   1. filenames are sanitized to a single safe path segment on write (no separators, no traversal);
//   2. every read resolves storage_path and asserts it stays inside ATTACHMENTS_DIR.

interface AttachmentRow {
  id: string;
  project_id: string;
  issue_id: string | null;
  ask_message_id: string | null;
  filename: string;
  mime: string;
  size_bytes: number;
  storage_path: string;
  created_at: string;
}

function mapRow(r: AttachmentRow): Attachment {
  return {
    id: r.id,
    project_id: r.project_id,
    issue_id: r.issue_id,
    ask_message_id: r.ask_message_id,
    filename: r.filename,
    mime: r.mime,
    size_bytes: r.size_bytes,
    created_at: r.created_at,
  };
}

/** Reduce an arbitrary client filename to one safe path segment (no dirs, no traversal, no leading dots). */
function safeStorageName(filename: string): string {
  const base = path.basename(filename || '').replace(/[^A-Za-z0-9._-]/g, '_');
  const stripped = base.replace(/^\.+/, ''); // kill '..' / hidden-file leading dots after basename
  return stripped.slice(0, 200) || 'file';
}

/**
 * Resolve a stored relative path to an absolute one, asserting it never escapes ATTACHMENTS_DIR
 * (§9.5-style containment). Defends the serve/read paths against a tampered or legacy storage_path.
 */
function resolveInsideRoot(storagePath: string): string {
  const root = path.resolve(ATTACHMENTS_DIR);
  const resolved = path.resolve(root, storagePath);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`attachment path escapes attachments dir: ${resolved} not under ${root}`);
  }
  return resolved;
}

export interface NewAttachment {
  project_id: string;
  issue_id?: string | null;
  ask_message_id?: string | null;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

/** Persist a blob to disk and insert its metadata row. Returns the display view model. */
export function createAttachment(input: NewAttachment): Attachment {
  const id = newId();
  const safeName = safeStorageName(input.filename);
  const storagePath = path.join(id, safeName); // relative; '<id>/<safe-name>'
  const absPath = resolveInsideRoot(storagePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, input.bytes);

  getDb()
    .prepare(
      `INSERT INTO attachments (id, project_id, issue_id, ask_message_id, filename, mime, size_bytes, storage_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.project_id,
      input.issue_id ?? null,
      input.ask_message_id ?? null,
      input.filename.slice(0, 255) || safeName,
      input.mime || 'application/octet-stream',
      input.bytes.byteLength,
      storagePath,
    );
  return getAttachment(id)!;
}

export function getAttachment(id: string): Attachment | null {
  const row = getDb().prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as
    | AttachmentRow
    | undefined;
  return row ? mapRow(row) : null;
}

/** Read an attachment's bytes for serving, applying the path-containment guard. */
export function readAttachment(id: string): { attachment: Attachment; bytes: Buffer } | null {
  const row = getDb().prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as
    | AttachmentRow
    | undefined;
  if (!row) return null;
  let absPath: string;
  try {
    absPath = resolveInsideRoot(row.storage_path);
  } catch {
    return null; // a row pointing outside the root is treated as missing, never served
  }
  if (!fs.existsSync(absPath)) return null;
  return { attachment: mapRow(row), bytes: fs.readFileSync(absPath) };
}

export function listAttachmentsByIssue(issueId: string): Attachment[] {
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE issue_id = ? ORDER BY created_at, rowid`)
    .all(issueId) as unknown as AttachmentRow[];
  return rows.map(mapRow);
}

/** Attachments for the given ids, returned in the order the ids were supplied. */
export function listAttachmentsByIds(ids: string[]): Attachment[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as AttachmentRow[];
  const byId = new Map(rows.map((r) => [r.id, mapRow(r)]));
  return ids.map((id) => byId.get(id)).filter((a): a is Attachment => a !== undefined);
}

/** Resolved Read-able references for prompt assembly — issue-scoped (every phase reuses these). */
export function listAttachmentRefsByIssue(issueId: string): PromptAttachment[] {
  return toRefs(
    getDb()
      .prepare(`SELECT * FROM attachments WHERE issue_id = ? ORDER BY created_at, rowid`)
      .all(issueId) as unknown as AttachmentRow[],
  );
}

/** Resolved Read-able references for prompt assembly — by explicit id list (the ask flow). */
export function listAttachmentRefsByIds(ids: string[]): PromptAttachment[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as AttachmentRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return toRefs(ids.map((id) => byId.get(id)).filter((r): r is AttachmentRow => r !== undefined));
}

/** Attachments grouped by their ask_message_id, for re-displaying a persisted conversation. */
export function attachmentsByAskMessage(messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE ask_message_id IN (${placeholders}) ORDER BY created_at, rowid`)
    .all(...messageIds) as unknown as AttachmentRow[];
  for (const row of rows) {
    const list = out.get(row.ask_message_id!) ?? [];
    list.push(mapRow(row));
    out.set(row.ask_message_id!, list);
  }
  return out;
}

/** Link previously-uploaded attachments to an issue (idempotent; scoped to unlinked-or-same-issue rows). */
export function linkAttachmentsToIssue(ids: string[], issueId: string): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  getDb()
    .prepare(
      // Only adopt rows not already owned by a different issue/ask turn — prevents stealing another
      // item's attachment by guessing its id.
      `UPDATE attachments SET issue_id = ?
       WHERE id IN (${placeholders}) AND (issue_id IS NULL OR issue_id = ?) AND ask_message_id IS NULL`,
    )
    .run(issueId, ...ids, issueId);
}

/** Link previously-uploaded attachments to an ask turn (same ownership guard as the issue link). */
export function linkAttachmentsToAskMessage(ids: string[], askMessageId: string): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  getDb()
    .prepare(
      `UPDATE attachments SET ask_message_id = ?
       WHERE id IN (${placeholders}) AND ask_message_id IS NULL AND issue_id IS NULL`,
    )
    .run(askMessageId, ...ids);
}

/** Count attachments already linked to an issue (for the per-item cap). */
export function countAttachmentsForIssue(issueId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE issue_id = ?`)
    .get(issueId) as { n: number };
  return row.n;
}

/** Delete one attachment: its blob (+ now-empty id dir) and its row. No-op if already gone. */
export function deleteAttachment(id: string): void {
  const row = getDb().prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as
    | AttachmentRow
    | undefined;
  if (!row) return;
  removeBlob(row);
  getDb().prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
}

/**
 * Delete an issue's attachment blobs (and rows). Call BEFORE deleting the issue — the FK cascade
 * removes the rows but never the on-disk files, so this reclaims them explicitly (SYM-35 NFR).
 */
export function deleteAttachmentsByIssue(issueId: string): void {
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE issue_id = ?`)
    .all(issueId) as unknown as AttachmentRow[];
  for (const row of rows) removeBlob(row);
  getDb().prepare(`DELETE FROM attachments WHERE issue_id = ?`).run(issueId);
}

function toRefs(rows: AttachmentRow[]): PromptAttachment[] {
  const refs: PromptAttachment[] = [];
  for (const row of rows) {
    try {
      refs.push({ filename: row.filename, mime: row.mime, path: resolveInsideRoot(row.storage_path) });
    } catch {
      /* skip a row that resolves outside the root rather than feed a bad path to an agent */
    }
  }
  return refs;
}

function removeBlob(row: AttachmentRow): void {
  try {
    const absPath = resolveInsideRoot(row.storage_path);
    fs.rmSync(path.dirname(absPath), { recursive: true, force: true }); // the per-id dir holds only this blob
  } catch {
    /* best-effort: a missing/escaping blob must not block deleting the row */
  }
}
