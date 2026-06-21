import { getDb } from '../db/client';
import { newId, issueKey } from '../core/keys';
import { deleteAttachmentsByIssue, linkAttachmentsToIssue } from './attachments';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  THINKING_EFFORTS,
  type Issue,
  type IssueMode,
  type IssueStatus,
  type IssueType,
  type MergeConflictInfo,
  type Priority,
  type ThinkingEffort,
} from '../../shared/types';

interface IssueRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  seq: number;
  key: string;
  type: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  labels: string;
  priority: number;
  status: string;
  mode: string;
  require_review: number;
  base_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  round: number;
  merge_conflict: string | null;
  thinking_effort: string | null;
  enable_workflow_tool: number | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: IssueRow): Issue {
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(r.labels);
    if (Array.isArray(parsed)) labels = parsed.map(String);
  } catch {
    /* keep [] */
  }
  let merge_conflict: MergeConflictInfo | null = null;
  if (r.merge_conflict) {
    try {
      merge_conflict = JSON.parse(r.merge_conflict) as MergeConflictInfo;
    } catch {
      /* malformed JSON ⇒ no decoration, mirror the labels fallback */
    }
  }
  return {
    id: r.id,
    project_id: r.project_id,
    parent_id: r.parent_id,
    key: r.key,
    type: r.type as IssueType,
    title: r.title,
    description: r.description,
    acceptance_criteria: r.acceptance_criteria,
    labels,
    priority: r.priority as Priority,
    status: r.status as IssueStatus,
    mode: r.mode as IssueMode,
    require_review: r.require_review !== 0,
    base_branch: r.base_branch,
    branch_name: r.branch_name,
    worktree_path: r.worktree_path,
    round: r.round,
    merge_conflict,
    // SYM-46: mapRow is the defensive boundary — only a whitelisted keyword survives; anything else
    // (NULL, a stale/garbage value written directly) reads back as null (= inherit).
    thinking_effort:
      r.thinking_effort && (THINKING_EFFORTS as readonly string[]).includes(r.thinking_effort)
        ? (r.thinking_effort as ThinkingEffort)
        : null,
    // SYM-67: stored as 0/1/NULL — NULL reads back as null (= inherit project ?? engine).
    enable_workflow_tool: r.enable_workflow_tool === null ? null : r.enable_workflow_tool !== 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface CreateIssueInput {
  project_id: string;
  title: string;
  parent_id?: string | null;
  type?: IssueType;
  description?: string | null;
  acceptance_criteria?: string | null;
  labels?: string[];
  priority?: Priority;
  status?: IssueStatus;
  mode?: IssueMode;
  require_review?: boolean;
  /** Per-issue extended-thinking override (SYM-46); null/undefined ⇒ inherit project ?? engine. */
  thinking_effort?: ThinkingEffort | null;
  /** Per-issue Workflow-tool override (SYM-67); null/undefined ⇒ inherit project ?? engine. */
  enable_workflow_tool?: boolean | null;
  /** Ids of previously-uploaded attachments to link to the new issue (SYM-35). */
  attachment_ids?: string[];
}

export function createIssue(input: CreateIssueInput): Issue {
  const db = getDb();
  const project = db
    .prepare(`SELECT key FROM projects WHERE id = ?`)
    .get(input.project_id) as { key: string } | undefined;
  if (!project) throw new Error(`project not found: ${input.project_id}`);

  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS max FROM issues WHERE project_id = ?`)
    .get(input.project_id) as { max: number };
  const seq = row.max + 1;
  const id = newId();

  db.prepare(
    `INSERT INTO issues
       (id, project_id, parent_id, seq, key, type, title, description,
        acceptance_criteria, labels, priority, status, mode, require_review, thinking_effort,
        enable_workflow_tool)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.parent_id ?? null,
    seq,
    issueKey(project.key, seq),
    input.type ?? 'feature',
    input.title,
    input.description ?? null,
    input.acceptance_criteria ?? null,
    JSON.stringify(input.labels ?? []),
    input.priority ?? 0,
    input.status ?? 'backlog',
    input.mode ?? 'manual',
    input.require_review === false ? 0 : 1,
    input.thinking_effort ?? null,
    // SYM-67: node:sqlite rejects a JS boolean bind — store 0/1, NULL = inherit.
    input.enable_workflow_tool == null ? null : input.enable_workflow_tool ? 1 : 0,
  );
  if (input.attachment_ids?.length) linkAttachmentsToIssue(input.attachment_ids, id);
  return getIssue(id)!;
}

export function getIssue(id: string): Issue | null {
  const row = getDb()
    .prepare(`SELECT * FROM issues WHERE id = ?`)
    .get(id) as IssueRow | undefined;
  return row ? mapRow(row) : null;
}

export function listIssues(projectId?: string): Issue[] {
  const rows = (
    projectId
      ? getDb()
          .prepare(`SELECT * FROM issues WHERE project_id = ? ORDER BY seq DESC`)
          .all(projectId)
      : getDb().prepare(`SELECT * FROM issues ORDER BY created_at DESC`).all()
  ) as unknown as IssueRow[];
  return rows.map(mapRow);
}

/** Issues by exact status set. */
export function listByStatuses(statuses: IssueStatus[]): Issue[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM issues WHERE status IN (${placeholders})`)
    .all(...statuses) as unknown as IssueRow[];
  return rows.map(mapRow);
}

/**
 * Dispatch candidates for the orchestrator: active status + auto mode, sorted by
 * priority (urgent first, "none" last), then oldest, then key.
 */
export function listAutoCandidates(): Issue[] {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT * FROM issues
       WHERE mode = 'auto' AND status IN (${placeholders})
       ORDER BY (CASE WHEN priority = 0 THEN 9 ELSE priority END) ASC, created_at ASC, key ASC`,
    )
    .all(...ACTIVE_STATUSES) as unknown as IssueRow[];
  return rows.map(mapRow);
}

export function getByIds(ids: string[]): Issue[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM issues WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as IssueRow[];
  return rows.map(mapRow);
}

const UPDATABLE = [
  'parent_id',
  'type',
  'title',
  'description',
  'acceptance_criteria',
  'priority',
  'status',
  'mode',
  'thinking_effort',
  'base_branch',
  'branch_name',
  'worktree_path',
] as const;

export interface UpdateIssueInput {
  parent_id?: string | null;
  type?: IssueType;
  title?: string;
  description?: string | null;
  acceptance_criteria?: string | null;
  labels?: string[];
  priority?: Priority;
  status?: IssueStatus;
  mode?: IssueMode;
  require_review?: boolean;
  /** Per-issue extended-thinking override (SYM-46); pass null to clear it back to inherit. */
  thinking_effort?: ThinkingEffort | null;
  /** Per-issue Workflow-tool override (SYM-67); pass null to clear it back to inherit. */
  enable_workflow_tool?: boolean | null;
  base_branch?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  /** Ids of previously-uploaded attachments to link to this issue (SYM-35); additive, never unlinks. */
  attachment_ids?: string[];
}

export function updateIssue(id: string, patch: UpdateIssueInput): Issue | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of UPDATABLE) {
    if (field in patch) {
      sets.push(`${field} = ?`);
      params.push((patch as Record<string, unknown>)[field] ?? null);
    }
  }
  if ('labels' in patch) {
    sets.push(`labels = ?`);
    params.push(JSON.stringify(patch.labels ?? []));
  }
  if ('require_review' in patch) {
    sets.push(`require_review = ?`);
    params.push(patch.require_review ? 1 : 0);
  }
  // SYM-67: kept OUT of the generic UPDATABLE loop — node:sqlite rejects a JS boolean bind, and a
  // null (clear-to-inherit) must round-trip as a real NULL, not 0. Store 0/1/NULL explicitly.
  if ('enable_workflow_tool' in patch) {
    sets.push(`enable_workflow_tool = ?`);
    params.push(patch.enable_workflow_tool == null ? null : patch.enable_workflow_tool ? 1 : 0);
  }
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
  params.push(id);
  getDb()
    .prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(params as never[]));
  // SYM-35: attachment_ids is not a column — link the listed uploads to this issue separately.
  if (patch.attachment_ids?.length) linkAttachmentsToIssue(patch.attachment_ids, id);
  return getIssue(id);
}

/** Convenience: set status + bump updated_at. */
export function setStatus(id: string, status: IssueStatus): Issue | null {
  return updateIssue(id, { status });
}

/**
 * Set the revision round. Deliberately NOT part of the UPDATABLE PATCH whitelist — only the
 * request-changes flow may advance the round, so clients can't set it via PATCH /:id.
 */
export function setRound(id: string, round: number): Issue | null {
  getDb()
    .prepare(
      `UPDATE issues SET round = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .run(round, id);
  return getIssue(id);
}

/**
 * Set (null to clear) the review-gate git-conflict decoration (SYM-29). Like setRound, kept OUT of
 * the UPDATABLE PATCH whitelist — only the approve / resolve-conflict gate actions may touch it, so
 * a client can't spoof a conflict (or silently clear a real one) via PATCH /:id.
 */
export function setMergeConflict(id: string, info: MergeConflictInfo | null): Issue | null {
  getDb()
    .prepare(
      `UPDATE issues SET merge_conflict = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .run(info ? JSON.stringify(info) : null, id);
  return getIssue(id);
}

export function clearMergeConflict(id: string): Issue | null {
  return setMergeConflict(id, null);
}

export function isActive(status: IssueStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminal(status: IssueStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function deleteIssue(id: string): void {
  // SYM-35: the FK cascade removes the attachment rows but never their on-disk blobs — reclaim
  // those explicitly first, then delete the issue (which cascades the now-orphaned rows away).
  deleteAttachmentsByIssue(id);
  getDb().prepare(`DELETE FROM issues WHERE id = ?`).run(id);
}
