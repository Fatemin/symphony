import { newId } from '../core/keys';
import { getDb } from '../db/client';
import type {
  Issue,
  IssueLink,
  IssueRelation,
  IssueRelationMap,
  IssueRelationType,
  IssueStatus,
  IssueType,
  Priority,
  StoryReferenceContext,
} from '../../shared/types';
import { getPlanContext } from './planContext';
import { createIssue, getIssue, type CreateIssueInput } from './issues';
import { listRuns } from './runs';
import { listTasks } from './tasks';

interface RelationRow {
  id: string;
  project_id: string;
  source_issue_id: string;
  target_issue_id: string;
  type: string;
  context_summary: string | null;
  created_at: string;
  source_id: string;
  source_project_id: string;
  source_key: string;
  source_type: string;
  source_title: string;
  source_status: string;
  source_priority: number;
  source_created_at: string;
  source_updated_at: string;
  target_id: string;
  target_project_id: string;
  target_key: string;
  target_type: string;
  target_title: string;
  target_status: string;
  target_priority: number;
  target_created_at: string;
  target_updated_at: string;
}

export interface CreateIssueRelationInput {
  source_issue_id: string;
  target_issue_id: string;
  type?: IssueRelationType;
  context_summary?: string | null;
}

export interface CreateFollowUpIssueInput extends Omit<CreateIssueInput, 'project_id' | 'parent_id'> {
  include_context?: boolean;
}

const MAX_CONTEXT_SUMMARY = 6_000;

const LINK_COLUMNS = /* sql */ `
  r.*,
  s.id AS source_id,
  s.project_id AS source_project_id,
  s.key AS source_key,
  s.type AS source_type,
  s.title AS source_title,
  s.status AS source_status,
  s.priority AS source_priority,
  s.created_at AS source_created_at,
  s.updated_at AS source_updated_at,
  t.id AS target_id,
  t.project_id AS target_project_id,
  t.key AS target_key,
  t.type AS target_type,
  t.title AS target_title,
  t.status AS target_status,
  t.priority AS target_priority,
  t.created_at AS target_created_at,
  t.updated_at AS target_updated_at
`;

function mapRelation(row: RelationRow): IssueRelation {
  return {
    id: row.id,
    project_id: row.project_id,
    source_issue_id: row.source_issue_id,
    target_issue_id: row.target_issue_id,
    type: normalizeRelationType(row.type),
    context_summary: row.context_summary,
    created_at: row.created_at,
    source: mapLink(row, 'source'),
    target: mapLink(row, 'target'),
  };
}

function mapLink(row: RelationRow, side: 'source' | 'target'): IssueLink {
  if (side === 'source') {
    return {
      id: row.source_id,
      project_id: row.source_project_id,
      key: row.source_key,
      type: row.source_type as IssueType,
      title: row.source_title,
      status: row.source_status as IssueStatus,
      priority: row.source_priority as Priority,
      created_at: row.source_created_at,
      updated_at: row.source_updated_at,
    };
  }
  return {
    id: row.target_id,
    project_id: row.target_project_id,
    key: row.target_key,
    type: row.target_type as IssueType,
    title: row.target_title,
    status: row.target_status as IssueStatus,
    priority: row.target_priority as Priority,
    created_at: row.target_created_at,
    updated_at: row.target_updated_at,
  };
}

function normalizeRelationType(value: string): IssueRelationType {
  return value === 'follow_up' ? 'follow_up' : 'relates_to';
}

export function createIssueRelation(input: CreateIssueRelationInput): IssueRelation {
  const source = getIssue(input.source_issue_id);
  if (!source) throw new Error(`source issue not found: ${input.source_issue_id}`);
  const target = getIssue(input.target_issue_id);
  if (!target) throw new Error(`target issue not found: ${input.target_issue_id}`);
  if (source.project_id !== target.project_id) {
    throw new Error('related issues must belong to the same project');
  }

  const type = input.type ?? 'relates_to';
  const context = cleanContext(input.context_summary);
  getDb()
    .prepare(
      `INSERT INTO issue_relations
         (id, project_id, source_issue_id, target_issue_id, type, context_summary)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_issue_id, target_issue_id, type)
       DO UPDATE SET context_summary = excluded.context_summary`,
    )
    .run(newId(), source.project_id, source.id, target.id, type, context);

  const relation = getIssueRelation(source.id, target.id, type);
  if (!relation) throw new Error('failed to create issue relation');
  return relation;
}

export function createFollowUpIssue(
  sourceIssueId: string,
  input: CreateFollowUpIssueInput,
): { issue: Issue; relation: IssueRelation } {
  const source = getIssue(sourceIssueId);
  if (!source) throw new Error(`source issue not found: ${sourceIssueId}`);

  const db = getDb();
  db.exec('BEGIN');
  try {
    const issue = createIssue({
      ...input,
      project_id: source.project_id,
      parent_id: null,
    });
    const relation = createIssueRelation({
      source_issue_id: source.id,
      target_issue_id: issue.id,
      type: 'follow_up',
      context_summary: input.include_context === false ? null : buildIssueContextSummary(source.id),
    });
    db.exec('COMMIT');
    return { issue, relation };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getIssueRelation(
  sourceIssueId: string,
  targetIssueId: string,
  type: IssueRelationType,
): IssueRelation | null {
  const row = getDb()
    .prepare(
      `SELECT ${LINK_COLUMNS}
       FROM issue_relations r
       JOIN issues s ON s.id = r.source_issue_id
       JOIN issues t ON t.id = r.target_issue_id
       WHERE r.source_issue_id = ? AND r.target_issue_id = ? AND r.type = ?`,
    )
    .get(sourceIssueId, targetIssueId, type) as RelationRow | undefined;
  return row ? mapRelation(row) : null;
}

export function listIssueRelations(issueId: string): IssueRelationMap {
  const db = getDb();
  const incoming = db
    .prepare(
      `SELECT ${LINK_COLUMNS}
       FROM issue_relations r
       JOIN issues s ON s.id = r.source_issue_id
       JOIN issues t ON t.id = r.target_issue_id
       WHERE r.target_issue_id = ?
       ORDER BY r.created_at ASC`,
    )
    .all(issueId) as unknown as RelationRow[];
  const outgoing = db
    .prepare(
      `SELECT ${LINK_COLUMNS}
       FROM issue_relations r
       JOIN issues s ON s.id = r.source_issue_id
       JOIN issues t ON t.id = r.target_issue_id
       WHERE r.source_issue_id = ?
       ORDER BY r.created_at ASC`,
    )
    .all(issueId) as unknown as RelationRow[];

  return {
    incoming: incoming.map(mapRelation),
    outgoing: outgoing.map(mapRelation),
  };
}

/**
 * Every relation in a project as a flat list (Story Tree tab, SYM-30). The client folds these into
 * a forest — `follow_up` edges nest source→target, `relates_to` surface as cross-links. Only issues
 * that appear in some relation have a story tree, so this list IS the "has a story tree" filter.
 */
export function listProjectRelations(projectId: string): IssueRelation[] {
  const rows = getDb()
    .prepare(
      `SELECT ${LINK_COLUMNS}
       FROM issue_relations r
       JOIN issues s ON s.id = r.source_issue_id
       JOIN issues t ON t.id = r.target_issue_id
       WHERE r.project_id = ?
       ORDER BY r.created_at ASC`,
    )
    .all(projectId) as unknown as RelationRow[];
  return rows.map(mapRelation);
}

export function listStoryReferenceContexts(issueId: string): StoryReferenceContext[] {
  return listIssueRelations(issueId).incoming
    .filter((relation) => relation.type === 'follow_up' && relation.context_summary?.trim())
    .map((relation) => ({
      relation_id: relation.id,
      source_issue_id: relation.source_issue_id,
      source_key: relation.source.key,
      source_title: relation.source.title,
      relation_type: relation.type,
      context_summary: relation.context_summary!.trim(),
    }));
}

export function buildIssueContextSummary(issueId: string): string | null {
  const issue = getIssue(issueId);
  if (!issue) return null;

  const lines: string[] = [
    `Source story ${issue.key}: ${issue.title}`,
    `Status: ${issue.status}`,
    `Type: ${issue.type}`,
  ];
  appendSection(lines, 'Description', issue.description);
  appendSection(lines, 'Acceptance criteria', issue.acceptance_criteria);

  const tasks = listTasks(issue.id);
  if (tasks.length > 0) {
    lines.push('', 'Plan tasks:');
    for (const task of tasks.slice(0, 12)) {
      lines.push(`- [${task.status}] (${task.role}) ${task.title}${task.intent ? ` - ${task.intent}` : ''}`);
    }
  }

  const planContext = getPlanContext(issue.id);
  if (planContext?.key_files.length) {
    lines.push('', 'Key files from planning:');
    for (const file of planContext.key_files.slice(0, 12)) {
      lines.push(`- ${file.path}${file.purpose ? `: ${file.purpose}` : ''}`);
    }
  }
  appendSection(lines, 'Implementation context from planning', planContext?.context);
  appendSection(lines, 'Planning notes', planContext?.notes);

  const runs = listRuns(issue.id);
  const latestImplement = runs.find((run) => run.phase === 'implement' && run.report?.trim());
  const latestQa = runs.find((run) => run.phase === 'qa' && run.report?.trim());
  appendSection(lines, 'Latest implementation report', latestImplement?.report?.slice(-1_500));
  appendSection(lines, 'Latest QA report', latestQa?.report?.slice(-1_000));

  return cleanContext(lines.join('\n'));
}

function appendSection(lines: string[], title: string, value: string | null | undefined): void {
  const text = value?.trim();
  if (!text) return;
  lines.push('', `${title}:`, text);
}

function cleanContext(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, MAX_CONTEXT_SUMMARY) : null;
}
