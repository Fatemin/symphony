import { Hono } from 'hono';
import { getOrchestrator } from '../../orchestrator/orchestrator';
import { getConfig, setSettings } from '../../repo/settings';
import { listIssueHistory } from '../../repo/runs';

export const opsRoutes = new Hono();

// Orchestrator runtime snapshot for the Ops page.
opsRoutes.get('/snapshot', (c) => c.json(getOrchestrator().snapshot()));

// Persisted per-issue run history (read-only). The snapshot only holds in-flight work; this is
// the durable record behind the Ops History panel. Optional ?project_id scopes to one project.
opsRoutes.get('/history', (c) => {
  const projectId = c.req.query('project_id');
  return c.json(listIssueHistory(projectId || undefined));
});

// Force an immediate poll tick.
opsRoutes.post('/snapshot/kick', async (c) => {
  await getOrchestrator().kick();
  return c.json({ ok: true });
});

// Effective engine configuration (defaults merged with the settings table).
opsRoutes.get('/settings', (c) => c.json(getConfig()));

opsRoutes.patch('/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  setSettings(body);
  return c.json(getConfig());
});
