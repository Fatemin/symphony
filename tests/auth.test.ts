import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// auth.ts is deliberately env-free (the token is passed in), so this test needs NO setupEnv and no
// server bootstrap — it constructs the middleware with a literal token and drives a tiny Hono app.
const { authMiddleware, isLoopbackHost } = await import('../src/server/http/middleware/auth');

const TOKEN = 'sekret-token';
const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/** A miniature of the production wiring: token gate in front of /api/* routes. */
function makeApp(token?: string) {
  const app = new Hono();
  app.use('*', authMiddleware(token));
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/projects', (c) => c.json({ ok: true }));
  return app;
}

// ── No token configured ⇒ transparent pass-through (localhost single-user default) ───────────

test('authMiddleware is a no-op when no token is configured', async () => {
  const app = makeApp(undefined);
  const res = await app.request('/api/projects');
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

// ── Token configured ⇒ protected routes require credentials ──────────────────────────────────

test('protected route returns 401 + WWW-Authenticate when credentials are missing', async () => {
  const app = makeApp(TOKEN);
  const res = await app.request('/api/projects');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('WWW-Authenticate'), 'Basic realm="Symphony"');
  assert.match(((await res.json()) as { error: string }).error, /Unauthorized/);
});

test('accepts a correct token via Bearer, Basic (any username), and ?token=', async () => {
  const app = makeApp(TOKEN);

  const bearer = await app.request('/api/projects', { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.status, 200, 'Bearer token');

  // Username is ignored — the password field carries the token (matches a browser Basic dialog).
  const basicAuth = await app.request('/api/projects', { headers: { Authorization: basic('anyuser', TOKEN) } });
  assert.equal(basicAuth.status, 200, 'Basic token');

  const query = await app.request(`/api/projects?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(query.status, 200, '?token= query param');
});

test('rejects a wrong token on every scheme', async () => {
  const app = makeApp(TOKEN);

  for (const headers of [{ Authorization: 'Bearer nope' }, { Authorization: basic('u', 'nope') }]) {
    const res = await app.request('/api/projects', { headers });
    assert.equal(res.status, 401);
  }
  // A length-mismatched token must fail cleanly (not throw) — timingSafeEqual needs equal lengths.
  const wrongLen = await app.request('/api/projects', { headers: { Authorization: 'Bearer x' } });
  assert.equal(wrongLen.status, 401);

  const wrongQuery = await app.request('/api/projects?token=nope');
  assert.equal(wrongQuery.status, 401);
});

test('GET /api/health is exempt even when a token is configured', async () => {
  const app = makeApp(TOKEN);
  const res = await app.request('/api/health');
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, 'ok');
});

// ── isLoopbackHost truth table ────────────────────────────────────────────────────────────────

test('isLoopbackHost is true only for loopback hosts', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.5.6.7', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(h), true, `${h} should be loopback`);
  }
  for (const h of [undefined, '', '0.0.0.0', '::', '[::]', '192.168.1.10', '10.0.0.5', 'example.com']) {
    assert.equal(isLoopbackHost(h), false, `${String(h)} should NOT be loopback`);
  }
});
