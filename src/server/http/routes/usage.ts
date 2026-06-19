import { Hono } from 'hono';
import type { LocalUsageReport } from '../../../shared/types';
import { readLocalUsage } from '../../usage/localUsage';

export const usageRoutes = new Hono();

/**
 * SYM-38 / SYM-39 / SYM-40: local Claude Code / Codex status for the sidebar footer. SYM-39 repurposed
 * it to report **remaining** rate-limit quota (`windows`) rather than spent tokens. SYM-40 made Claude
 * report remaining too: it reads the CLIs' own session logs AND, for Claude, makes ONE best-effort
 * outbound GET to Anthropic's usage endpoint with the user's own local OAuth token (so this route is no
 * longer strictly no-network for Claude). That fetch's failures degrade to `unsupported` (today's usage
 * fallback) — they never fail the request. Per-agent errors are isolated inside the reader, so this
 * always returns `200` with a status per agent rather than a `500` when one CLI dir is missing/locked.
 * The response shape is unchanged (`generated_at` + `agents`); only percentages/reset times reach the
 * client — the token is never logged nor returned.
 */
usageRoutes.get('/local', async (c) => {
  const report: LocalUsageReport = {
    generated_at: new Date().toISOString(),
    agents: await readLocalUsage(),
  };
  return c.json(report);
});
