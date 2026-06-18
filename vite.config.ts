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
    port: 5173,
    proxy: {
      // Regex key (note the trailing slash) so this matches `/api/...` requests but NOT the
      // client's own `/api.ts` module — a plain `/api` prefix would hijack it and break the app.
      '^/api/': { target: 'http://localhost:3030', changeOrigin: true },
    },
  },
});
