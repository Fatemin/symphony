# Symphony — HTTP & SSE API

The complete server API, grounded in the Hono entry ([`src/server/index.ts`](../src/server/index.ts))
and the route modules in [`src/server/http/routes/`](../src/server/http/routes/). All routes are
mounted under **`/api`**. In dev the Vite client proxies `/api/*` to the Hono server on `:3030`; in
production the same server also serves the built SPA.

This is a **single-user, localhost tool** — there is no authentication, no rate limiting, and no
versioning. Request bodies are JSON; responses are JSON unless noted (SSE for the stream route).

## Conventions

- **Mount points** (`index.ts`): `/api/projects` (project CRUD **and** the `ask` sub-routes),
  `/api/issues`, `/api/ops`, `/api/usage`, `/api/stream`, `/api/fs`, plus `GET /api/health`.
- **Errors** are `{ "error": "<message>" }` with a 4xx/5xx status; review-gate actions return
  `{ "ok": false, "reason": "<message>" }`.
- **Status codes** used deliberately: `201` create, `202` accepted/dispatched, `204` no content,
  `400` bad input, `404` not found, `409` conflict/illegal-state, `422` nothing imported,
  `502` upstream (agent/GitHub) failure.

---

## Health

### `GET /api/health`
Liveness probe. → `200 { "status": "ok" }`.

---

## Projects — `/api/projects` (`http/routes/projects.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/projects` | List all projects. |
| `POST` | `/api/projects` | Create a project. Body requires `name`; `409` if the derived/supplied `key` collides. → `201` |
| `GET` | `/api/projects/:id` | One project **plus** its issues (`{ ...project, issues }`). `404` if missing. |
| `PATCH` | `/api/projects/:id` | Update project fields (incl. `model`, `context`, `agent`, `default_branch`, `preview_command`, `config`). `404` if missing. |
| `DELETE` | `/api/projects/:id` | Delete a project (cascades issues etc.). → `204` |
| `GET` | `/api/projects/:id/branches` | Git branches of the project's repo (`{ default_branch, branches }`); empty list if no `repo_path`. |
| `GET` | `/api/projects/:id/relations` | Flat list of the project's `issue_relations` edges; the client folds these into the Story Tree (SYM-30). |
| `GET` | `/api/projects/:id/docs` | Documentation listing (SYM-36): `{ directories, files }` where each `DocEntry` is `{ path, name, dir }`. Reads the allow-listed text/markdown files under `config.docs.directories` (default `['docs']`). Empty `files` when no `repo_path`. |
| `GET` | `/api/projects/:id/docs/content?path=` | One doc's contents (`{ path, name, content }`) for the reading pane. `path` is repo-relative and validated against the configured directories + repo root: `400` on traversal/absolute/disallowed extension/out-of-dir, `404` on missing file or no `repo_path`. |

### Project skills (SYM-14)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/projects/:id/skills` | List the project's skills. |
| `POST` | `/api/projects/:id/skills` | Create a manual skill. Body requires `name`; `409` on duplicate name. → `201` |
| `POST` | `/api/projects/:id/skills/import` | Import a skill from a GitHub `url`. Fetch failure → `502`; duplicate → `409`. → `201` |
| `POST` | `/api/projects/:id/skills/install` | Install a marketplace plugin's skills from a pasted `command`. Parse error → `400`; fetch failure → `502`; per-skill duplicates collected into `skipped`. → `201` if any imported, else `422`. |
| `PATCH` | `/api/projects/:id/skills/:skillId` | Update a skill (e.g. toggle `enabled`). `404` if not in this project; `409` on name clash. |
| `DELETE` | `/api/projects/:id/skills/:skillId` | Delete a skill. → `204` |

### Ask — conversational project Q&A (`http/routes/ask.ts`, mounted under `/api/projects`)

Read-only Q&A against the project's **real repo** (not a worktree). Synchronous request/response — no
run rows, no orchestrator. The agent is pinned to a read-only permission mode and may end by drafting a
feature/bug suggestion.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/projects/:id/ask` | Ask a question. Body: `{ question, history?, agent? }`. → `{ answer, session_id, suggestion }`. No `repo_path` → `400`; agent failure → `502`. Persists the turn under today's conversation. |
| `GET` | `/api/projects/:id/ask/history` | Today's persisted conversation (`{ date, messages }`) to reseed the panel. |
| `DELETE` | `/api/projects/:id/ask/history` | Reset today's conversation ("new conversation"). → `{ ok: true }` |

---

## Issues — `/api/issues` (`http/routes/issues.ts`)

### CRUD & detail

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/issues?project_id=&status=` | List issues; both query params optional filters. |
| `POST` | `/api/issues` | Create an issue. Body requires `project_id` + `title`. → `201` |
| `GET` | `/api/issues/:id` | Full detail: the issue plus `tasks`, `runs`, `events` (latest 200), `relations`, `revisions`. `404` if missing. |
| `PATCH` | `/api/issues/:id` | Update issue fields (status, mode, priority, etc.). Moving to a terminal status mid-run cancels the active run; `cancelled` also cleans up the branch/worktree. |
| `DELETE` | `/api/issues/:id` | Cancel any active run, clean up resources, delete the issue. → `204` (also `204` if already gone). |
| `POST` | `/api/issues/:id/follow-ups` | Create a follow-up issue linked to a **completed** source (`409` if source not `done`). Body requires `title`; `include_context` (default true) carries predecessor context. → `201` |

### Activity & review evidence

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/issues/:id/events?since=` | Activity feed since a cursor (polling fallback for SSE; also the initial load). |
| `GET` | `/api/issues/:id/diff` | The agent branch's diff vs its base (`{ available, base, branch, stat, files, patch, truncated }`); `available:false` when repo/branch info is missing. |

### Run & review-gate actions

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/issues/:id/run` | Manual "Run": dispatch this issue now regardless of `mode`. → `202` on dispatch, `409` if it can't (terminal / already running / no free slots). |
| `POST` | `/api/issues/:id/approve` | Approve the review gate. Body (all optional): `{ target_branch?, create_branch?, set_default_branch? }`. Direct-merge mode merges the agent branch into base and (per `promotion.push`) pushes; pull-request mode rebases, verifies, pushes, and opens/merges a PR with `gh`. On success the issue → `done`. `409` on a merge conflict / diverged remote (leaves a `merge_conflict` decoration) or non-review status; `400` on missing branch info. |
| `POST` | `/api/issues/:id/resolve-conflict` | Re-run the merge for a parked issue carrying a `merge_conflict` decoration, reconciling a diverged remote agent-side. Guarded on `status=review` + a recorded conflict (`409` otherwise). On success → `done` and clears the marker. |
| `POST` | `/api/issues/:id/request-changes` | Start a new revision round. Body requires `feedback`. Records the revision, bumps `round`, clears any stale conflict marker, returns the issue to `todo`, and re-dispatches. → `202 { ok, round, dispatched, reason }`; `409` if not in `review`; `400` if no feedback. |

### Preview server

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/issues/:id/preview` | Current preview status for the issue. |
| `POST` | `/api/issues/:id/preview` | Launch the project from the issue's worktree (uses `project.preview_command` or a default). `409` if there is no worktree yet. |
| `DELETE` | `/api/issues/:id/preview` | Stop the preview. → `{ running: false, stopped }` |

---

## Ops — `/api/ops` (`http/routes/ops.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/ops/snapshot` | Orchestrator runtime snapshot (`Snapshot`): running rows, queued retries, token totals, poll interval, WIP limit, enabled flag, any active suspension. |
| `GET` | `/api/ops/history?project_id=` | Persisted per-issue run history (`OpsHistoryRow[]`); the durable record behind the Ops History panel. `project_id` optional. |
| `POST` | `/api/ops/snapshot/kick` | Force an immediate orchestrator poll tick. → `{ ok: true }` |
| `GET` | `/api/ops/settings` | Effective engine config (defaults merged with the `settings` table → `EngineConfig`). |
| `PATCH` | `/api/ops/settings` | Update engine settings; returns the new effective config. |

`EngineConfig` includes the SYM-41 agent-execution controls `enable_workflow_tool` (boolean, default
`false` — off keeps the orchestrator the sole scheduler) and `thinking_effort`
(`none`/`think`/`think-hard`/`ultrathink`, default `none`). Both are also per-project overridable
through `PATCH /api/projects/:id`'s `config.agent` blob (undefined ⇒ inherit the engine default); see
[DATA_MODEL.md](DATA_MODEL.md) §settings and §projects.

---

## Usage — `/api/usage` (`http/routes/usage.ts`)

Read-only, computed (no DB). Reads the **local** Claude Code / Codex CLI session logs on the same
machine for the sidebar footer. SYM-39 repurposed this from spent token *usage* to **remaining**
rate-limit quota (the user wants to see what's left). Codex logs its live rate limits locally; Claude
does not, so Claude reports `unsupported`. Today's token totals are still computed for the tooltip.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/usage/local` | Per-agent remaining quota + today's token totals (`LocalUsageReport`). |

`GET /api/usage/local` → `200 { generated_at, agents }`:

- `generated_at` — ISO timestamp of the snapshot.
- `agents` — one `AgentUsageReport` per agent (`claude`, `codex`), each `{ agent, status, usage, windows?, error? }`:
  - `status`: `ok` (Codex: a rate-limit snapshot was found → `windows` populated), `empty` (Codex:
    dir found but no recent snapshot), `unsupported` (Claude: dir found but remaining quota isn't
    available locally — run `/usage` in the Claude CLI), `not_found` (the CLI's data dir doesn't
    exist — not installed / never run), `error` (read failure; `error` carries the reason).
  - `windows` (Codex `ok` only) — array of `RateWindow` `{ key, used_percent, remaining_percent,
    window_minutes, resets_at }` from the **latest** rate-limit snapshot. `key` is `primary` (short
    rolling window) or `secondary` (weekly); `remaining_percent = clamp(0, 100, 100 − used_percent)`;
    `resets_at` is epoch **milliseconds** (0 if unknown). A window whose `resets_at` already passed
    has rolled over since the snapshot, so it's reported as fully remaining (used 0 / left 100) with
    `resets_at` projected forward to the next boundary.
  - `usage`: `{ input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens }`,
    summed across **today's** sessions (the tooltip figure). `total_tokens` is the sum of the other four.

**Always `200`** — each agent is read inside its own try/catch, so a missing/locked CLI dir yields a
per-agent `not_found`/`error` row rather than failing the whole request. **"Today" (for the usage
totals) is the server's local-machine day** (Symphony runs locally beside the CLIs). Codex rate-limit
snapshots are scanned across rollouts touched within ~8 days (so the weekly window stays visible);
the today-only usage filter is per-line, so the wider file set doesn't change the usage numbers. Data
roots honor `CLAUDE_CONFIG_DIR` (Claude, may be comma-separated; else `~/.claude` + `~/.config/claude`)
and `CODEX_HOME` (Codex; else `~/.codex`), read at request time.

---

## Stream (SSE) — `/api/stream` (`http/routes/stream.ts`)

### `GET /api/stream/issues/:id?since=<cursor>`
Server-Sent Events for one issue's activity. On connect it **replays** every event after `?since=`
(cursor), then streams live events from the in-process bus. A ~15 s heartbeat (`event: ping`) keeps
the connection and any proxies alive. Each data message carries the event (kind + JSON payload) with
the cursor as the SSE `id`; the browser `EventSource` fires `onmessage` for every event (no custom
`event:` field on data messages). Reconnect with the last seen cursor as `?since=` to resume without
gaps.

---

## Filesystem picker — `/api/fs` (`http/routes/fs.ts`)

Supports the project `repo_path` picker on a localhost single-user machine. Exposes directory **names
only** — never file contents.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/fs/browse?path=` | Subdirectories of `path` (`~`/relative/env expanded), each flagged `isGitRepo`; falls back to the home dir when `path` is missing/invalid. Returns `{ path, parent, isGitRepo, entries }`. |
| `GET` | `/api/fs/validate?path=` | Validate a typed/selected path. Always `200`; the payload's `ok`/`error`/`warning` describe the result (a non-git directory is a *warning*, not an error). |

---

## Related docs

- Request/response shapes map to the domain types in
  [`src/shared/types.ts`](../src/shared/types.ts) — see [DATA_MODEL.md](DATA_MODEL.md).
- The lifecycle behind the run/approve/request-changes endpoints is in
  [ARCHITECTURE.md](ARCHITECTURE.md).
- Per-project policy referenced by `approve` (verification/promotion/commit_guard) is the
  `WORKFLOW.md` / project `config` contract — see [AGENT_GUIDE.md](AGENT_GUIDE.md) and
  [`WORKFLOW.example.md`](../WORKFLOW.example.md).
