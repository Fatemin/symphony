import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ALLOW_INSECURE_LAN, AUTH_TOKEN, HOST, IS_PROD, PORT } from './env';
import { getDb } from './db/client';
import { authMiddleware, isLoopbackHost } from './http/middleware/auth';
import { log } from './observability/logger';
import { bus } from './observability/bus';
import { getOrchestrator } from './orchestrator/orchestrator';
import { stopAllPreviews } from './preview/manager';
import { projectRoutes } from './http/routes/projects';
import { askRoutes } from './http/routes/ask';
import { attachmentRoutes } from './http/routes/attachments';
import { issueRoutes } from './http/routes/issues';
import { opsRoutes } from './http/routes/ops';
import { streamRoutes } from './http/routes/stream';
import { fsRoutes } from './http/routes/fs';
import { usageRoutes } from './http/routes/usage';

getDb(); // open + bootstrap the database before anything else

const app = new Hono();

// Minimal access control (SYM-42): a single shared-token gate in front of /api AND the prod SPA.
// No-op when SYMPHONY_AUTH_TOKEN is unset (the localhost single-user default). Mounted before the
// routes + static so every sensitive endpoint (/api/fs, issue create, …) is covered in one place;
// the middleware internally exempts GET /api/health.
app.use('*', authMiddleware(AUTH_TOKEN));

const api = new Hono();
api.get('/health', (c) => c.json({ status: 'ok' }));
api.route('/projects', projectRoutes);
api.route('/projects', askRoutes); // project-scoped conversational Q&A (POST /projects/:id/ask)
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

// Secure-by-default startup guard (SYM-42): refuse to start when bound to a non-loopback interface
// without a token. bypassPermissions agents = arbitrary command execution, so silent unauthenticated
// LAN exposure is unacceptable. SYMPHONY_ALLOW_INSECURE_LAN downgrades the refusal to a loud warning.
// Runs before the orchestrator's poll loop so an exposed-without-auth boot fails fast.
if (!isLoopbackHost(HOST)) {
  if (!AUTH_TOKEN) {
    const risk = 'bypassPermissions agents = arbitrary command execution exposed to the LAN';
    if (ALLOW_INSECURE_LAN) {
      log.warn('SECURITY: bound to a non-loopback interface with NO authentication', { host: HOST, risk });
    } else {
      log.error('refusing to start: non-loopback HOST without authentication', {
        host: HOST,
        risk,
        fix: 'set SYMPHONY_AUTH_TOKEN=<secret> (recommended), or SYMPHONY_ALLOW_INSECURE_LAN=1 to override (unsafe)',
      });
      process.exit(1);
    }
  } else {
    log.info('LAN access enabled with shared-token auth', { host: HOST });
  }
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
