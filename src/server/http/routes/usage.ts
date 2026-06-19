import { Hono } from 'hono';
import type { LocalUsageReport } from '../../../shared/types';
import { readLocalUsage } from '../../usage/localUsage';

export const usageRoutes = new Hono();

/**
 * SYM-38 / SYM-39: local Claude Code / Codex status for the sidebar footer. SYM-39 repurposed it to
 * report **remaining** rate-limit quota (Codex `windows`) rather than spent tokens; Claude has no local
 * quota state and reports `unsupported`. Read-only — it only reads the CLIs' own session logs. Per-agent
 * errors are isolated inside the reader, so this always returns `200` with a status per agent rather
 * than a `500` when one CLI dir is missing/locked. The response shape is unchanged (`generated_at` +
 * `agents`); the additive `windows`/`unsupported` fields are stamped by the reader.
 */
usageRoutes.get('/local', async (c) => {
  const report: LocalUsageReport = {
    generated_at: new Date().toISOString(),
    agents: await readLocalUsage(),
  };
  return c.json(report);
});
