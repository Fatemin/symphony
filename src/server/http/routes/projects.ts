import { Hono } from 'hono';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../../repo/projects';
import {
  createProjectSkill,
  deleteProjectSkill,
  getProjectSkill,
  listProjectSkills,
  updateProjectSkill,
} from '../../repo/projectSkills';
import { fetchGithubSkill, parseGithubSkillRef, type FetchedSkill } from '../../core/githubSkill';
import { fetchMarketplaceSkills, fetchRepoSkills, parseMarketplaceImport } from '../../core/marketplaceSkill';
import { listIssues } from '../../repo/issues';
import { latestPhaseByIssue } from '../../repo/runs';
import { listProjectRelations } from '../../repo/issueRelations';
import { listBranches } from '../../workspace/worktree';
import { listProjectDocs, readProjectDoc } from '../../workspace/docs';
import { parseProjectConfig } from '../../core/projectConfig';
import type {
  BoardIssue,
  DocListing,
  MarketplaceInstallResult,
  ProjectSkill,
  SkillCopyResult,
  SkillCopyTargetResult,
} from '../../../shared/types';

export const projectRoutes = new Hono();

projectRoutes.get('/', (c) => c.json(listProjects()));

projectRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }
  // projects.key is UNIQUE (db/schema.ts) — a derived or supplied key can collide with an
  // existing project, so translate the constraint error to a friendly 409 (mirrors skills).
  try {
    return c.json(createProject(body), 201);
  } catch (e) {
    return c.json({ error: projectErrorMessage(e) }, 409);
  }
});

projectRoutes.get('/:id/branches', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!project.repo_path) return c.json({ default_branch: project.default_branch, branches: [] });
  return c.json(await listBranches(project.repo_path, project.default_branch));
});

projectRoutes.get('/:id', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  // SYM-32: attach each in-progress issue's live phase so the board card can show plan/implement/qa.
  // The phase is only meaningful while work is running, so non-in_progress issues report null.
  const issues = listIssues(project.id);
  const inProgressIds = issues.filter((i) => i.status === 'in_progress').map((i) => i.id);
  const phases = latestPhaseByIssue(inProgressIds);
  const boardIssues: BoardIssue[] = issues.map((i) => ({
    ...i,
    current_phase: i.status === 'in_progress' ? (phases.get(i.id) ?? null) : null,
  }));
  return c.json({ ...project, issues: boardIssues });
});

// Flat list of the project's issue relations — the client folds these into the Story Tree (SYM-30).
projectRoutes.get('/:id/relations', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json(listProjectRelations(project.id));
});

// SYM-36: the Documentation tab. List the docs found under the project's configured directories
// (config.docs.directories, default ['docs']). Empty listing when the project has no on-disk repo,
// mirroring the /:id/branches route's graceful behaviour.
projectRoutes.get('/:id/docs', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const { directories } = parseProjectConfig(project.config).docs;
  if (!project.repo_path) return c.json({ directories, files: [] } satisfies DocListing);
  return c.json(listProjectDocs(project.repo_path, directories));
});

// SYM-36: read a single doc's contents for the reading pane. The path is repo-relative and validated
// against the configured directories + repo root (400 on traversal/disallowed, 404 on missing file).
projectRoutes.get('/:id/docs/content', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!project.repo_path) return c.json({ error: 'this project has no linked repo' }, 404);
  const { directories } = parseProjectConfig(project.config).docs;
  const result = readProjectDoc(project.repo_path, directories, c.req.query('path') ?? '');
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.doc);
});

projectRoutes.patch('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const project = updateProject(c.req.param('id'), body);
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json(project);
});

projectRoutes.delete('/:id', (c) => {
  deleteProject(c.req.param('id'));
  return c.body(null, 204);
});

// ── project skills (SYM-14) ───────────────────────────────────────────────

projectRoutes.get('/:id/skills', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json(listProjectSkills(project.id));
});

projectRoutes.post('/:id/skills', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400);
  try {
    return c.json(createProjectSkill({ ...body, project_id: project.id, source: 'manual' }), 201);
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 409);
  }
});

// Pull a skill (or skills) from GitHub and store them. A bare github.com/<owner>/<repo> URL resolves
// EVERY skill in the repo across the root, flat skills/, and skills/<name>/ layouts (SYM-58, via
// fetchRepoSkills) — unifying this panel with /skills/install; an explicit blob/tree/raw link stays
// single-skill (the SYM-52 contract). Parse/fetch failures → 502; per-skill duplicates are collected
// into `skipped` (mirrors /skills/install), 201 when any skill landed, else 422.
projectRoutes.post('/:id/skills/import', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.url || typeof body.url !== 'string') return c.json({ error: 'url is required' }, 400);
  let fetched: FetchedSkill[];
  try {
    // parseGithubSkillRef is pure but throws on a malformed/unsupported URL — same 502 surface as a
    // fetch failure. A bare repo fans out to all layouts; any other shape stays a single skill.
    const ref = parseGithubSkillRef(body.url);
    fetched = ref.bareRepo
      ? await fetchRepoSkills(ref.owner, ref.repo, body.url)
      : [await fetchGithubSkill(body.url)];
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 502);
  }
  const imported: ProjectSkill[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const skill of fetched) {
    try {
      imported.push(
        createProjectSkill({
          project_id: project.id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          files: skill.files,
          source: 'github',
          source_url: skill.source_url,
        }),
      );
    } catch (e) {
      skipped.push({ name: skill.name, reason: skillErrorMessage(e) });
    }
  }
  const result: MarketplaceInstallResult = { imported, skipped };
  return c.json(result, imported.length ? 201 : 422);
});

// Install the skills of a Claude Code marketplace plugin from the pasted /plugin commands (SYM-17).
// Parse errors → 400; GitHub fetch failures → 502; per-skill duplicates are collected into `skipped`
// rather than failing the batch. 201 when at least one skill landed, 422 when none did.
projectRoutes.post('/:id/skills/install', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.command || typeof body.command !== 'string') {
    return c.json({ error: 'command is required' }, 400);
  }
  let spec;
  try {
    spec = parseMarketplaceImport(body.command);
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 400);
  }
  let fetched;
  try {
    fetched = await fetchMarketplaceSkills(spec);
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 502);
  }
  const imported: ProjectSkill[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const skill of fetched) {
    try {
      imported.push(
        createProjectSkill({
          project_id: project.id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          files: skill.files,
          source: 'marketplace',
          source_url: skill.source_url,
        }),
      );
    } catch (e) {
      skipped.push({ name: skill.name, reason: skillErrorMessage(e) });
    }
  }
  const result: MarketplaceInstallResult = { imported, skipped };
  return c.json(result, imported.length ? 201 : 422);
});

// Copy this project's skills into one or more OTHER projects (SYM-64). `:id` is the SOURCE; the body
// is `{ target_project_ids: string[]; skill_ids?: string[] }`. Each selected skill is re-created in
// every target as a fresh row preserving provenance (name/description/content/files/source/source_url/
// enabled) — a push, so the source list is untouched. The source id is silently dropped from the
// target list (no self-copy) and the list is de-duped; a target id that no longer exists is reported
// with an `error` note rather than failing the batch; per-skill name collisions land in that target's
// `skipped` (same unique-name mapping as the create/import routes). 201 when any skill landed in any
// target, else 422; 400 on an empty/invalid target list, 404 on an unknown source project.
projectRoutes.post('/:id/skills/copy', async (c) => {
  const source = getProject(c.req.param('id'));
  if (!source) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const targetIds: unknown = body.target_project_ids;
  if (!Array.isArray(targetIds) || targetIds.length === 0 || !targetIds.every((t) => typeof t === 'string')) {
    return c.json({ error: 'target_project_ids must be a non-empty array of project ids' }, 400);
  }
  // Load the source skills once; when skill_ids is present, copy only that subset (ids not belonging
  // to the source are silently ignored, mirroring how the import routes tolerate partial input).
  let skills = listProjectSkills(source.id);
  if (Array.isArray(body.skill_ids)) {
    const wanted = new Set((body.skill_ids as unknown[]).map((s) => String(s)));
    skills = skills.filter((s) => wanted.has(s.id));
  }
  const results: SkillCopyTargetResult[] = [];
  let importedAny = false;
  // De-dupe the target list and drop the source itself, so [source, t, t] copies to t exactly once.
  for (const targetId of new Set(targetIds as string[])) {
    if (targetId === source.id) continue; // never copy a project's skills onto itself
    const target = getProject(targetId);
    if (!target) {
      results.push({ project_id: targetId, project_name: '', imported: [], skipped: [], error: 'project not found' });
      continue;
    }
    const imported: ProjectSkill[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const skill of skills) {
      try {
        imported.push(
          createProjectSkill({
            project_id: target.id,
            name: skill.name,
            description: skill.description,
            content: skill.content,
            files: skill.files,
            source: skill.source,
            source_url: skill.source_url,
            enabled: skill.enabled,
          }),
        );
      } catch (e) {
        // The (project_id, name) unique index throws when the target already has that skill.
        skipped.push({ name: skill.name, reason: skillErrorMessage(e) });
      }
    }
    if (imported.length) importedAny = true;
    results.push({ project_id: target.id, project_name: target.name, imported, skipped });
  }
  const result: SkillCopyResult = { results };
  return c.json(result, importedAny ? 201 : 422);
});

projectRoutes.patch('/:id/skills/:skillId', async (c) => {
  const skill = getProjectSkill(c.req.param('skillId'));
  if (!skill || skill.project_id !== c.req.param('id')) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(updateProjectSkill(skill.id, body));
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 409);
  }
});

projectRoutes.delete('/:id/skills/:skillId', (c) => {
  const skill = getProjectSkill(c.req.param('skillId'));
  if (skill && skill.project_id === c.req.param('id')) deleteProjectSkill(skill.id);
  return c.body(null, 204);
});

/** Map repo/fetch errors to a user-facing message (the unique-name index throws on duplicates). */
function skillErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unique|constraint/i.test(msg)) return 'a skill with that name already exists in this project';
  return msg;
}

/** Map a project INSERT failure to a user-facing message (projects.key is UNIQUE). */
function projectErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unique|constraint/i.test(msg)) return 'a project with that key already exists';
  return msg;
}
