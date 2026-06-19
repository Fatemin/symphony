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
import { fetchGithubSkill } from '../../core/githubSkill';
import { fetchMarketplaceSkills, parseMarketplaceImport } from '../../core/marketplaceSkill';
import { listIssues } from '../../repo/issues';
import { listBranches } from '../../workspace/worktree';
import type { MarketplaceInstallResult, ProjectSkill } from '../../../shared/types';

export const projectRoutes = new Hono();

projectRoutes.get('/', (c) => c.json(listProjects()));

projectRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }
  return c.json(createProject(body), 201);
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
  return c.json({ ...project, issues: listIssues(project.id) });
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

// Pull a skill's SKILL.md from GitHub and store it. Fetch failures → 502; duplicate name → 409.
projectRoutes.post('/:id/skills/import', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.url || typeof body.url !== 'string') return c.json({ error: 'url is required' }, 400);
  let fetched;
  try {
    fetched = await fetchGithubSkill(body.url);
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 502);
  }
  try {
    return c.json(
      createProjectSkill({
        project_id: project.id,
        name: fetched.name,
        description: fetched.description,
        content: fetched.content,
        files: fetched.files,
        source: 'github',
        source_url: fetched.source_url,
      }),
      201,
    );
  } catch (e) {
    return c.json({ error: skillErrorMessage(e) }, 409);
  }
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
