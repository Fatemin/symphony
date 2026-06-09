import { getDb } from '../db/client';
import { newId, deriveProjectKey } from '../core/keys';
import type { Project } from '../../shared/types';

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string;
  repo_path: string | null;
  default_branch: string;
  context: string | null;
  model: string | null;
  created_at: string;
}

const mapRow = (r: ProjectRow): Project => ({ ...r });

export interface CreateProjectInput {
  name: string;
  key?: string;
  description?: string | null;
  color?: string;
  repo_path?: string | null;
  default_branch?: string;
  context?: string | null;
  model?: string | null;
}

export function createProject(input: CreateProjectInput): Project {
  const id = newId();
  const key = (input.key?.trim() || deriveProjectKey(input.name)).toUpperCase();
  getDb()
    .prepare(
      `INSERT INTO projects (id, key, name, description, color, repo_path, default_branch, context, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      key,
      input.name,
      input.description ?? null,
      input.color ?? '#6366F1',
      input.repo_path ?? null,
      input.default_branch ?? 'main',
      input.context ?? null,
      input.model ?? null,
    );
  return getProject(id)!;
}

export function getProject(id: string): Project | null {
  const row = getDb()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(id) as ProjectRow | undefined;
  return row ? mapRow(row) : null;
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare(`SELECT * FROM projects ORDER BY created_at DESC`)
    .all() as unknown as ProjectRow[];
  return rows.map(mapRow);
}

const UPDATABLE = [
  'name',
  'description',
  'color',
  'repo_path',
  'default_branch',
  'context',
  'model',
] as const;

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, (typeof UPDATABLE)[number]>>,
): Project | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of UPDATABLE) {
    if (field in patch) {
      sets.push(`${field} = ?`);
      params.push(patch[field] ?? null);
    }
  }
  if (sets.length > 0) {
    params.push(id);
    getDb()
      .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as never[]));
  }
  return getProject(id);
}

export function deleteProject(id: string): void {
  getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}
