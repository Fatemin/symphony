import { Hono } from 'hono';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../../repo/projects';
import { listIssues } from '../../repo/issues';
import { listBranches } from '../../workspace/worktree';

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
