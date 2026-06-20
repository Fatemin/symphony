# Symphony — Deployment & LAN access

Symphony is built as a **single-user, localhost-first** tool. This page covers the one supported step
beyond that: making the UI reachable from other devices on your **local network (LAN)** safely.

> ⚠️ **Read the security premise first.** Symphony's pipeline runs coding agents with
> `permission_mode=bypassPermissions` — there is no human at the CLI to approve each step, so agents
> execute arbitrary shell commands on the host machine *inside their worktree*. Exposing the server to
> the network without authentication is therefore equivalent to **publishing an unauthenticated
> arbitrary-command-execution console** to everyone on that network. Symphony will not let you do that
> by accident (see [secure-by-default](#secure-by-default) below).

---

## Secure by default

By default the server binds **`localhost` only** (`HOST=localhost`). Nothing on the LAN can reach it;
existing single-user usage is unchanged and needs no token.

To go beyond localhost you change two things deliberately:

1. **Bind a non-loopback interface** — `HOST=0.0.0.0` (all interfaces) or a specific IP.
2. **Set a shared token** — `SYMPHONY_AUTH_TOKEN=<secret>`.

If you bind a non-loopback `HOST` **without** a token, the server **refuses to start** and logs how to
fix it:

```
level=error msg="refusing to start: non-loopback HOST without authentication"
  host=0.0.0.0 risk="bypassPermissions agents = arbitrary command execution exposed to the LAN"
  fix="set SYMPHONY_AUTH_TOKEN=<secret> (recommended), or SYMPHONY_ALLOW_INSECURE_LAN=1 to override (unsafe)"
```

Setting `SYMPHONY_ALLOW_INSECURE_LAN=1` downgrades the refusal to a loud warning and starts anyway —
**only** do this on a network you fully trust and have otherwise isolated.

---

## Recommended path: production single port

The cleanest authenticated LAN deployment serves the built client and the API from the **same** Hono
port, so the browser's Basic credentials cover every same-origin request (page, `/api`, SSE stream,
attachment images):

```bash
npm run build
HOST=0.0.0.0 SYMPHONY_AUTH_TOKEN='choose-a-long-random-secret' npm start
```

Then from a LAN device open `http://<host-ip>:3030`. The browser prompts for credentials once
(**username: anything, password: the token**) and reuses them for the whole app.

`PORT` (default `3030`) changes the listening port.

---

## Authentication schemes

When `SYMPHONY_AUTH_TOKEN` is set, the gate accepts the shared token presented any of three ways
(`GET /api/health` is always exempt for liveness checks):

| Scheme | How |
|--------|-----|
| HTTP Basic | `Authorization: Basic base64(<anyuser>:<token>)` — username ignored. This is what browsers send after the native login dialog. |
| Bearer | `Authorization: Bearer <token>` — convenient for `curl` / scripts. |
| Query param | `?token=<token>` — fallback for tools that can't set headers (e.g. an `<img>`/`EventSource` URL). |

Anything else gets `401 Unauthorized` with `WWW-Authenticate: Basic realm="Symphony"` (which triggers
the browser login dialog). The comparison is constant-time.

```bash
curl -i http://<host-ip>:3030/api/projects                 # 401 + WWW-Authenticate
curl -u x:<token>     http://<host-ip>:3030/api/projects    # 200 (Basic)
curl -H "Authorization: Bearer <token>" http://<host-ip>:3030/api/projects   # 200
curl http://<host-ip>:3030/api/health                       # 200 without creds (exempt)
```

The token is **environment-only by design** — it is never written to the `settings` table or returned
by `GET /api/ops/settings`, so it can't leak through the config API. Keep it in `.env` (gitignored).

---

## Dev mode on the LAN

In `npm run dev` the React client is served by Vite (`:5173`) and proxies `/api/*` to the backend
(`:3030`). To reach the dev client from another device, bind Vite to the LAN:

```bash
# either
SYMPHONY_WEB_HOST=true npm run dev          # all interfaces
SYMPHONY_WEB_HOST=0.0.0.0 npm run dev:web    # web only, all interfaces
# or the Vite flag
npm run dev:web -- --host
```

`SYMPHONY_WEB_HOST` accepts `true` (all interfaces) or a literal host; unset keeps the historical
localhost-only default. The Vite proxy target stays `localhost:3030` because the proxy runs on the dev
machine next to the backend — so set `SYMPHONY_AUTH_TOKEN` on the backend and the middleware still
gates `/api` through the proxy.

> ⚠️ **Caveat (split origin).** With Vite on `:5173` proxying to the backend on `:3030`, the first
> unauthenticated `/api` call returns `401`, but the native browser Basic-auth dialog does not pop
> reliably in every browser for a proxied XHR/`fetch`. The **supported authenticated-LAN path is the
> production single port** above (`npm run build && npm start`); dev-LAN is best for quick same-trust
> use. A polished in-app login screen is intentionally out of scope.

---

## Transport security (plaintext HTTP)

Symphony serves **plain HTTP** — the shared token (and everything else) crosses the wire unencrypted.
On a trusted home/office LAN that is usually acceptable; on anything less, **do not** rely on the token
alone. Put Symphony behind a TLS-terminating reverse proxy (Caddy, nginx, a tailnet, etc.) or an SSH
tunnel if confidentiality matters. Symphony has no built-in TLS, rate limiting, account system, or
multi-tenancy — the shared token is a minimal gate, not a full auth stack.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `localhost` | Interface the server binds to. Non-loopback requires a token (or the override). |
| `PORT` | `3030` | Server port. |
| `SYMPHONY_AUTH_TOKEN` | *(unset)* | Shared secret enabling the access-control middleware. Unset ⇒ no auth (localhost only). |
| `SYMPHONY_ALLOW_INSECURE_LAN` | *(unset)* | `1`/`true` to allow a non-loopback bind **without** a token (downgrades the refusal to a warning). Unsafe. |
| `SYMPHONY_WEB_HOST` | *(unset)* | Vite dev-server bind. `true` = all interfaces; or a literal host. Dev only. |
| `SYMPHONY_DATA_DIR` | `./data` | Root for the SQLite DB + attachment blobs. |
| `SYMPHONY_DB_PATH` | `<DATA_DIR>/symphony.db` | Explicit SQLite file path. |
| `SYMPHONY_WORKSPACE_ROOT` | `<tmp>/symphony_workspaces` | Where per-issue git worktrees are created. |

Backward compatibility: with none of these set the server binds `localhost`, runs with no auth, and
behaves exactly as before — the only default-behavior change is that it no longer binds every
interface implicitly.
