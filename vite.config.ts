import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The client lives in src/web; it proxies /api (REST + SSE) to the Hono server on :3030.
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    // SYM-42: bind the dev client to the LAN via SYMPHONY_WEB_HOST. Unset/empty keeps the historical
    // localhost-only behavior (`false`); `'true'` binds all interfaces; any other value is a literal
    // host. SECURITY: exposing the dev client forwards LAN traffic to the proxied backend — set
    // SYMPHONY_AUTH_TOKEN so the backend middleware still gates /api through the proxy. For a clean
    // authenticated LAN deployment prefer the prod single-port path (`npm run build && npm start`).
    host: process.env.SYMPHONY_WEB_HOST === 'true' ? true : process.env.SYMPHONY_WEB_HOST || false,
    port: 5173,
    proxy: {
      // Regex key (note the trailing slash) so this matches `/api/...` requests but NOT the
      // client's own `/api.ts` module — a plain `/api` prefix would hijack it and break the app.
      // Target stays localhost:3030 — the proxy runs on the dev machine alongside the backend.
      '^/api/': { target: 'http://localhost:3030', changeOrigin: true },
    },
  },
});
