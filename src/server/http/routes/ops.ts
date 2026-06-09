import { Hono } from 'hono';
import { getOrchestrator } from '../../orchestrator/orchestrator';
import { getConfig, setSettings } from '../../repo/settings';

export const opsRoutes = new Hono();

// Orchestrator runtime snapshot for the Ops page.
opsRoutes.get('/snapshot', (c) => c.json(getOrchestrator().snapshot()));

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
