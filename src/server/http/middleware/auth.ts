import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Minimal access control for LAN deployments (SYM-42).
 *
 * Symphony's pipeline runs agents with `bypassPermissions` (arbitrary command execution on the host),
 * so exposing the server beyond localhost without a gate would open a command console to the network.
 * This is the ONLY place credential checking lives. It is deliberately env-free (the token is passed
 * in) so it can be unit-tested with a literal token and has no DB/settings dependency — the token is
 * NEVER persisted (it would leak through `GET /api/ops/settings`).
 *
 * One shared secret, three equivalent ways to present it so the supported clients (browser, curl,
 * EventSource, <img>) all work with zero web-client changes:
 *   - `Authorization: Bearer <token>`
 *   - `Authorization: Basic base64(<anyuser>:<token>)` — the password field is the token; username is
 *     ignored, so a browser's native Basic-auth dialog reuses cached credentials for every same-origin
 *     subrequest (fetch + SSE + images), which is why the React client needs no token plumbing.
 *   - `?token=<token>` query param — a fallback for tools that can't set headers.
 */
export function authMiddleware(token?: string): MiddlewareHandler {
  // No token configured ⇒ the localhost single-user default: a transparent pass-through.
  if (!token) {
    return async (_c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    // Liveness probe stays open so health checks / load balancers work without credentials.
    if (c.req.path === '/api/health') {
      await next();
      return;
    }

    const candidate = extractCredential(c);
    if (candidate !== undefined && safeEqual(candidate, token)) {
      await next();
      return;
    }

    // Prompt browsers for Basic credentials; everything else gets a clean 401.
    c.header('WWW-Authenticate', 'Basic realm="Symphony"');
    return c.json({ error: 'Unauthorized' }, 401);
  };
}

/** Pull a candidate token from the Authorization header (Bearer or Basic) or the `?token=` query. */
function extractCredential(c: Context): string | undefined {
  const header = c.req.header('Authorization'); // Hono header lookup is case-insensitive
  if (header) {
    if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
    if (header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        // Take the password (after the first colon), ignoring the username — `user:pass` or bare `pass`.
        return sep === -1 ? decoded : decoded.slice(sep + 1);
      } catch {
        return undefined;
      }
    }
  }
  return c.req.query('token') || undefined;
}

/** Constant-time string compare. A length mismatch fails fast WITHOUT throwing (timingSafeEqual
 *  requires equal-length buffers), so a wrong-length token can't crash the request. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True only for loopback hosts (SYM-42). Drives the informational LAN-exposure warning at startup: a
 * non-loopback bind without a token logs a non-blocking notice (SYM-44 — it no longer refuses to
 * start). Matches `localhost`, the whole `127.0.0.0/8` block, and IPv6 `::1` (bracketed or not).
 * `0.0.0.0` / `::` (all-interfaces) and any specific LAN IP/hostname are NOT loopback;
 * `undefined`/empty is treated as non-loopback (fail safe).
 */
export function isLoopbackHost(host?: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
