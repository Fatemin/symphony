# Symphony — Deployment & LAN access

Symphony is built as a **single-user, localhost-first** tool. This page covers the one supported step
beyond that: making the UI reachable from other devices on your **local network (LAN)** — and the
security premise you should understand before you do.

> ⚠️ **Read the security premise first.** Symphony's pipeline runs coding agents with
> `permission_mode=bypassPermissions` — there is no human at the CLI to approve each step, so agents
> execute arbitrary shell commands. Those commands run on the **machine hosting the Symphony backend**
> (see [Where agents run](#where-agents-run)), *inside their worktree*. Exposing the server to the LAN
> therefore lets anyone on that network drive that command execution. On a trusted home/office LAN this
> is usually fine; for an untrusted network, add the [optional token](#optional-hardening-shared-token).

---

## Enabling LAN access

By default the server binds **`localhost` only** (`HOST=localhost`), so an existing install never
starts exposing itself on upgrade. Nothing on the LAN can reach it; localhost single-user usage is
unchanged and needs no token.

To reach the UI from another device, bind a non-loopback interface — that's the **only** required
change (SYM-44 dropped the previous requirement that LAN access also carry a token):

```bash
npm run build
HOST=0.0.0.0 npm start          # all interfaces, no auth — fine on a trusted LAN
```

Then from a LAN device open `http://<host-ip>:3030`.

When you bind a non-loopback `HOST` **without** a token, the server starts and logs a one-line notice
so the exposure is a conscious choice, not a silent one:

```
level=warn msg="bound to a non-loopback interface with NO authentication"
  host=0.0.0.0
  risk="bypassPermissions agents run arbitrary commands on THIS host; the LAN can reach them unauthenticated"
  hardening="set SYMPHONY_AUTH_TOKEN=<secret> to gate access on an untrusted network"
```

### Optional hardening (shared token)

On an untrusted or shared network, set a shared token to gate access:

```bash
HOST=0.0.0.0 SYMPHONY_AUTH_TOKEN='choose-a-long-random-secret' npm start
```

The browser then prompts for credentials once (**username: anything, password: the token**) and
reuses them for the whole app. The token is optional hardening, not a requirement.

---

## Where agents run

A LAN client runs **only the browser** — the React UI talking to the backend over HTTP. Everything
else happens on the machine running the Symphony backend:

- The orchestrator's poll loop lives **in the backend process** (`orchestrator.start()` in
  [`src/server/index.ts`](../src/server/index.ts)).
- Each phase spawns the Claude / Codex CLI via `child_process.spawn`
  ([`src/server/agent/claudeRunner.ts`](../src/server/agent/claudeRunner.ts),
  [`codexRunner.ts`](../src/server/agent/codexRunner.ts)) as a **child of the backend process**.
- The agent's working directory is a git worktree under `workspace_root` **on the backend host**.

So the answer to "which machine actually invokes Claude Code?" is: **the host running the Symphony
backend**, never the remote LAN device that opened the UI. A phone or laptop browsing in from across
the network triggers runs but executes nothing locally. This is exactly why LAN exposure is a
*server-host* command-execution concern, and why the optional token gates the server, not the client.

---

## Recommended path: production single port

The cleanest LAN deployment serves the built client and the API from the **same** Hono port, so one
origin covers every request (page, `/api`, SSE stream, attachment images) — and, *if* you add a token,
the browser's Basic credentials cover them all in one prompt:

```bash
npm run build
HOST=0.0.0.0 npm start                                       # trusted LAN, no auth
HOST=0.0.0.0 SYMPHONY_AUTH_TOKEN='long-random-secret' npm start   # + optional token hardening
```

Then from a LAN device open `http://<host-ip>:3030`. With a token set, the browser prompts for
credentials once (**username: anything, password: the token**) and reuses them for the whole app.

`PORT` (default `3030`) changes the listening port.

---

## Authentication schemes (optional)

Auth is **off unless you set `SYMPHONY_AUTH_TOKEN`**. When set, the gate accepts the shared token
presented any of three ways
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

Then from a LAN device open `http://<LAN-IP>:5173` (find `<LAN-IP>` with `ipconfig getifaddr en0` on
macOS, or `hostname -I` on Linux).

`SYMPHONY_WEB_HOST` accepts `true` (all interfaces) or a literal host/IP; unset keeps the historical
localhost-only default. It is the **only** variable you set for dev-LAN access — you do **not** change
the backend `HOST` or switch to `npm start`. The reason: the Vite proxy runs on the same dev machine as
the backend and forwards `/api` to `localhost:3030` ([`vite.config.ts`](../vite.config.ts)), so the
backend keeps its default `localhost` bind ([`src/server/env.ts`](../src/server/env.ts)) and `/api`
still resolves through the proxy.

> ⚠️ **Security — the dev page is not auth-gated.** The page Vite serves on `:5173` is **static and
> never passes through Hono's auth middleware** — only the proxied `/api` calls are gated, and even
> then the first unauthenticated `/api` call returns `401` while the native browser Basic-auth dialog
> does not pop reliably in every browser for a proxied XHR/`fetch`. The backend reached through that
> proxy still runs pipeline agents with `permission_mode=bypassPermissions` (arbitrary commands on the
> dev host), so set `SYMPHONY_AUTH_TOKEN` on the backend. For a clean authenticated LAN setup prefer
> the production single-port path ([Recommended path](#recommended-path-production-single-port),
> `npm run build && npm start`); dev-LAN is best for quick same-trust use. A polished in-app login
> screen is intentionally out of scope.

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
| `HOST` | `localhost` | Interface the server binds to. Set `0.0.0.0` (or a specific IP) for LAN access — no token required. |
| `PORT` | `3030` | Server port. |
| `SYMPHONY_AUTH_TOKEN` | *(unset)* | **Optional** shared secret enabling the access-control middleware. Unset ⇒ no auth. |
| `SYMPHONY_WEB_HOST` | *(unset)* | Vite dev-server bind. `true` = all interfaces; or a literal host. Dev only. |
| `SYMPHONY_DATA_DIR` | `./data` | Root for the SQLite DB + attachment blobs. |
| `SYMPHONY_DB_PATH` | `<DATA_DIR>/symphony.db` | Explicit SQLite file path. |
| `SYMPHONY_WORKSPACE_ROOT` | `<tmp>/symphony_workspaces` | Where per-issue git worktrees are created. |

Backward compatibility: with none of these set the server binds `localhost` and runs with no auth,
exactly as before. Binding a non-loopback `HOST` now **starts** (with a one-line warning) instead of
refusing — the token is optional hardening, not a requirement.
