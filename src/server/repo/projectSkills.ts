import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { ProjectSkill, ProjectSkillFile, ProjectSkillSource } from '../../shared/types';

// One row per project skill (see db/schema.ts#project_skills). Enabled rows are materialized into
// each issue worktree by workspace/skills.ts before the agent pipeline runs.
interface ProjectSkillRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  content: string;
  files: string | null;
  source: string;
  source_url: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const mapRow = (r: ProjectSkillRow): ProjectSkill => ({
  id: r.id,
  project_id: r.project_id,
  name: r.name,
  description: r.description,
  content: r.content,
  files: parseFiles(r.files),
  source: r.source === 'github' ? 'github' : 'manual',
  source_url: r.source_url,
  enabled: r.enabled !== 0,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

function parseFiles(value: string | null): ProjectSkillFile[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return normalizeFiles(parsed);
  } catch {
    return [];
  }
}

/** Keep only well-formed {path, content} entries (defensive against hand-edited JSON). */
function normalizeFiles(value: unknown): ProjectSkillFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({ path: String(f.path ?? '').trim(), content: String(f.content ?? '') }))
    .filter((f) => f.path.length > 0);
}

function serializeFiles(files: ProjectSkillFile[] | null | undefined): string | null {
  const clean = normalizeFiles(files);
  return clean.length ? JSON.stringify(clean) : null;
}

export interface CreateProjectSkillInput {
  project_id: string;
  name: string;
  description?: string | null;
  content?: string | null;
  files?: ProjectSkillFile[] | null;
  source?: ProjectSkillSource;
  source_url?: string | null;
  enabled?: boolean;
}

/** Insert a skill. The (project_id, name) unique index throws on a duplicate name — callers map it. */
export function createProjectSkill(input: CreateProjectSkillInput): ProjectSkill {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO project_skills (id, project_id, name, description, content, files, source, source_url, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.project_id,
      input.name.trim(),
      input.description?.trim() || null,
      input.content ?? '',
      serializeFiles(input.files),
      input.source === 'github' ? 'github' : 'manual',
      input.source_url?.trim() || null,
      input.enabled === false ? 0 : 1,
    );
  return getProjectSkill(id)!;
}

export function getProjectSkill(id: string): ProjectSkill | null {
  const row = getDb()
    .prepare(`SELECT * FROM project_skills WHERE id = ?`)
    .get(id) as ProjectSkillRow | undefined;
  return row ? mapRow(row) : null;
}

/** All skills for a project, newest first. */
export function listProjectSkills(projectId: string): ProjectSkill[] {
  const rows = getDb()
    .prepare(`SELECT * FROM project_skills WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(projectId) as unknown as ProjectSkillRow[];
  return rows.map(mapRow);
}

export interface UpdateProjectSkillInput {
  name?: string;
  description?: string | null;
  content?: string | null;
  files?: ProjectSkillFile[] | null;
  source?: ProjectSkillSource;
  source_url?: string | null;
  enabled?: boolean;
}

const UPDATABLE = ['name', 'description', 'content', 'files', 'source', 'source_url', 'enabled'] as const;

/** Patch a subset of columns; always refreshes updated_at. Returns the updated row (or null). */
export function updateProjectSkill(id: string, patch: UpdateProjectSkillInput): ProjectSkill | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of UPDATABLE) {
    if (!(field in patch)) continue;
    if (field === 'files') {
      sets.push(`files = ?`);
      params.push(serializeFiles(patch.files));
    } else if (field === 'enabled') {
      sets.push(`enabled = ?`);
      params.push(patch.enabled === false ? 0 : 1);
    } else {
      const value = patch[field];
      sets.push(`${field} = ?`);
      params.push(typeof value === 'string' ? value.trim() || null : value ?? null);
    }
  }
  if (sets.length === 0) return getProjectSkill(id);
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
  params.push(id);
  getDb()
    .prepare(`UPDATE project_skills SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(params as never[]));
  return getProjectSkill(id);
}

export function deleteProjectSkill(id: string): void {
  getDb().prepare(`DELETE FROM project_skills WHERE id = ?`).run(id);
}
