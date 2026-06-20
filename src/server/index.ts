import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AUTH_TOKEN, HOST, IS_PROD, PORT } from './env';
import { getDb } from './db/client';
import { authMiddleware, isLoopbackHost } from './http/middleware/auth';
import { log } from './observability/logger';
import { bus } from './observability/bus';
import { getOrchestrator } from './orchestrator/orchestrator';
import { stopAllPreviews } from './preview/manager';
import { projectRoutes } from './http/routes/projects';
import { askRoutes } from './http/routes/ask';
import { reviewRoutes } from './http/routes/reviews';
import { attachmentRoutes } from './http/routes/attachments';
import { issueRoutes } from './http/routes/issues';
import { opsRoutes } from './http/routes/ops';
import { streamRoutes } from './http/routes/stream';
import { fsRoutes } from './http/routes/fs';
import { usageRoutes } from './http/routes/usage';
import { failInterruptedReviewRuns } from './repo/reviews';

getDb(); // open + bootstrap the database before anything else

// SYM-51: a review run is a background promise with no orchestrator backing it, so a restart while
// one was in flight would leave its row stuck 'running' (and block new runs). Fail those once at boot.
const interruptedReviews = failInterruptedReviewRuns();
if (interruptedReviews > 0) {
  log.info('failed interrupted review runs at startup', { count: interruptedReviews });
}

const app = new Hono();

// Minimal access control (SYM-42): a single shared-token gate in front of /api AND the prod SPA.
// No-op when SYMPHONY_AUTH_TOKEN is unset (the default). Opt-in hardening only — LAN access no longer
// requires it (SYM-44). Mounted before the routes + static so every sensitive endpoint (/api/fs, issue
// create, …) is covered in one place; the middleware internally exempts GET /api/health.
app.use('*', authMiddleware(AUTH_TOKEN));

const api = new Hono();
api.get('/health', (c) => c.json({ status: 'ok' }));
api.route('/projects', projectRoutes);
api.route('/projects', askRoutes); // project-scoped conversational Q&A (POST /projects/:id/ask)
api.route('/projects', reviewRoutes); // SYM-51: standalone read-only project review (POST /projects/:id/reviews)
api.route('/issues', issueRoutes);
api.route('/attachments', attachmentRoutes);
api.route('/ops', opsRoutes);
api.route('/stream', streamRoutes);
api.route('/fs', fsRoutes);
api.route('/usage', usageRoutes); // SYM-38: local CLI token-usage for the sidebar footer
app.route('/api', api);

// In production, serve the built client and SPA-fallback to index.html.
if (IS_PROD) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('/*', serveStatic({ path: './dist/index.html' }));
}

// Non-loopback LAN-exposure notice (SYM-44, was a fatal guard in SYM-42). LAN access no longer
// requires a token, but the agent pipeline runs with bypassPermissions (= arbitrary command execution
// on THIS host — the server, never the LAN client). So a non-loopback bind without a token is informed
// consent, not an error: warn loudly, point at the optional hardening, and start anyway.
if (!isLoopbackHost(HOST) && !AUTH_TOKEN) {
  log.warn('bound to a non-loopback interface with NO authentication', {
    host: HOST,
    risk: 'bypassPermissions agents run arbitrary commands on THIS host; the LAN can reach them unauthenticated',
    hardening: 'set SYMPHONY_AUTH_TOKEN=<secret> to gate access on an untrusted network',
  });
}

// Wire the scheduler's events into the live bus, then start polling.
const orchestrator = getOrchestrator({ onEvent: (event) => bus.publish(event) });
orchestrator.start();

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  log.info('server listening', {
    host: HOST,
    port: info.port,
    prod: IS_PROD,
    auth: AUTH_TOKEN ? 'enabled' : 'disabled',
  });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  orchestrator.stop();
  stopAllPreviews();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
