import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { IS_PROD, PORT } from './env';
import { getDb } from './db/client';
import { log } from './observability/logger';
import { bus } from './observability/bus';
import { getOrchestrator } from './orchestrator/orchestrator';
import { stopAllPreviews } from './preview/manager';
import { projectRoutes } from './http/routes/projects';
import { issueRoutes } from './http/routes/issues';
import { opsRoutes } from './http/routes/ops';
import { streamRoutes } from './http/routes/stream';
import { fsRoutes } from './http/routes/fs';

getDb(); // open + bootstrap the database before anything else

const app = new Hono();

const api = new Hono();
api.get('/health', (c) => c.json({ status: 'ok' }));
api.route('/projects', projectRoutes);
api.route('/issues', issueRoutes);
api.route('/ops', opsRoutes);
api.route('/stream', streamRoutes);
api.route('/fs', fsRoutes);
app.route('/api', api);

// In production, serve the built client and SPA-fallback to index.html.
if (IS_PROD) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('/*', serveStatic({ path: './dist/index.html' }));
}

// Wire the scheduler's events into the live bus, then start polling.
const orchestrator = getOrchestrator({ onEvent: (event) => bus.publish(event) });
orchestrator.start();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  log.info('server listening', { port: info.port, prod: IS_PROD });
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
