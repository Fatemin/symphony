import { Hono } from 'hono';
import type { LocalUsageReport } from '../../../shared/types';
import { readLocalUsage } from '../../usage/localUsage';

export const usageRoutes = new Hono();

/**
 * SYM-38: today's local Claude Code / Codex token usage for the sidebar footer. Read-only — it only
 * reads the CLIs' own session logs. Per-agent errors are isolated inside the reader, so this always
 * returns `200` with a status per agent rather than a `500` when one CLI dir is missing/locked.
 */
usageRoutes.get('/local', async (c) => {
  const report: LocalUsageReport = {
    generated_at: new Date().toISOString(),
    agents: await readLocalUsage(),
  };
  return c.json(report);
});
