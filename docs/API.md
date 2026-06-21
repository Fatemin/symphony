# Symphony — HTTP & SSE API

The complete server API, grounded in the Hono entry ([`src/server/index.ts`](../src/server/index.ts))
and the route modules in [`src/server/http/routes/`](../src/server/http/routes/). All routes are
mounted under **`/api`**. In dev the Vite client proxies `/api/*` to the Hono server on `:3030`; in
production the same server also serves the built SPA.

This is a **single-user, localhost tool** — no rate limiting and no versioning. By default it binds
`localhost` and runs with no authentication. LAN access needs no auth either (just `HOST=0.0.0.0`); an
**optional shared-token gate** can be enabled for hardening on untrusted networks (see
[Authentication](#authentication) below and [docs/DEPLOYMENT.md](DEPLOYMENT.md)). Request bodies are
JSON; responses are JSON unless noted (SSE for the stream route).

## Conventions

- **Mount points** (`index.ts`): `/api/projects` (project CRUD **and** the `ask` + `reviews`
  sub-routes), `/api/issues`, `/api/attachments`, `/api/ops`, `/api/usage`, `/api/stream`, `/api/fs`,
  plus `GET /api/health`.
- **Errors** are `{ "error": "<message>" }` with a 4xx/5xx status; review-gate actions return
  `{ "ok": false, "reason": "<message>" }`.
- **Status codes** used deliberately: `201` create, `202` accepted/dispatched, `204` no content,
  `400` bad input, `401` unauthorized (auth enabled, bad/missing token), `404` not found,
  `409` conflict/illegal-state, `413` payload too large (oversize attachment upload),
  `422` nothing imported, `502` upstream (agent/GitHub) failure.

## Authentication

Auth is **off by default and entirely optional** (SYM-44 — LAN access no longer forces it). Setting
`SYMPHONY_AUTH_TOKEN` (SYM-42) mounts a shared-token middleware (`http/middleware/auth.ts`) in front of
**every** route — `/api/*` and, in production, the served SPA — except `GET /api/health`, which stays
open for liveness checks. The token is environment-only (it never appears in `GET /api/ops/settings`).
Present it any of three ways:

- `Authorization: Bearer <token>`
- `Authorization: Basic base64(<anyuser>:<token>)` — username ignored (matches a browser Basic dialog)
- `?token=<token>` query param

A missing/wrong token returns `401 { "error": "Unauthorized" }` with `WWW-Authenticate: Basic
realm="Symphony"`. Binding a non-loopback `HOST` without a token **starts** (with a one-line warning),
it does not refuse — see [docs/DEPLOYMENT.md](DEPLOYMENT.md).

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
| `GET` | `/api/projects/:id` | One project **plus** its issues (`{ ...project, issues }`). Each issue is a `BoardIssue` (Issue + derived `current_phase` + `source_label`). SYM-78: `source_label` is the issue's origin label (e.g. `Review · Code`), resolved from `source_run_id` → the review run's scope via a single id-IN lookup; `null` for manual issues and for review issues whose run was deleted. `404` if missing. |
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
| `POST` | `/api/projects/:id/skills/import` | Import a skill (or skills) from a GitHub `url`. Accepts a `blob`/`tree`/`raw` link to a `SKILL.md` (or its folder) — **single-skill** — **or a bare repo URL** `github.com/<owner>/<repo>`. The bare form (SYM-52 + SYM-58) resolves the repo's default branch and now imports **every** skill regardless of layout: a `SKILL.md` at the repo root, directly under `skills/`, **or in `skills/<name>/` subdirectories** (multi-skill) — unifying this panel with `/skills/install`, so a single pasted repo URL "just works". When neither flat layout nor any `skills/<name>/` subdir holds a `SKILL.md`, the error names the layouts tried and the `GITHUB_TOKEN` rate-limit remedy. A folder/tree/bare URL (anything not ending in `.md`) also fetches each skill directory's sibling files into `files` so multi-file skills import completely (SYM-50, bounded by file-count/byte/depth caps); an explicit `*.md` URL stays single-file. Returns the same batch result as `/skills/install` — `{ imported: ProjectSkill[], skipped: { name, reason }[] }` — collecting per-skill duplicates into `skipped` (a single-skill duplicate now lands in `skipped` rather than a top-level `409`). Parse/fetch failure / `SKILL.md` not found / rate limit → `502`; `201` when any skill imported, else `422`. |
| `POST` | `/api/projects/:id/skills/install` | Install a marketplace plugin's skills from a pasted `command`. Each skill is resolved through the same `fetchGithubSkill` path, so multi-file plugin skills also get their sibling `files` (SYM-50). When a plugin's `skills/<name>/` listing is empty it falls back (SYM-52) to a flat `SKILL.md` at the plugin/repo root or directly under `skills/`, so single-skill repos install. Parse error → `400`; fetch failure → `502`; per-skill duplicates collected into `skipped`. → `201` if any imported, else `422`. |
| `POST` | `/api/projects/:id/skills/copy` | Copy this project's skills into one or more **other** projects (SYM-64). `:id` is the **source**; body `{ target_project_ids: string[], skill_ids?: string[] }`. Without `skill_ids` every source skill is copied; otherwise only the listed ids (ids not on the source are ignored). Each selected skill is re-created in every target as a fresh row preserving `name`/`description`/`content`/`files`/`source`/`source_url`/`enabled` — a **push**, so the source rows are untouched. The source id is dropped from the target list (no self-copy) and the list is de-duped; an unknown target id is returned with an `error` note instead of failing the batch; per-skill name collisions land in that target's `skipped`. Returns `{ results: SkillCopyTargetResult[] }`, each `{ project_id, project_name, imported, skipped, error? }`. `400` on an empty/invalid `target_project_ids`; `404` if the source is missing; `201` when any skill imported into any target, else `422`. |
| `PATCH` | `/api/projects/:id/skills/:skillId` | Update a skill (e.g. toggle `enabled`). `404` if not in this project; `409` on name clash. |
| `DELETE` | `/api/projects/:id/skills/:skillId` | Delete a skill. → `204` |

### Ask — conversational project Q&A (`http/routes/ask.ts`, mounted under `/api/projects`)

Read-only Q&A against the project's **real repo** (not a worktree). Synchronous request/response — no
run rows, no orchestrator. The agent is pinned to a read-only permission mode and may end by drafting a
feature/bug suggestion. The request is intentionally **not** cancellable: closing the Ask panel mid-run
disconnects the client but does **not** abort the in-flight reply (no `AbortSignal` is bound to the
runner, SYM-48) — the answer is generated and persisted on completion regardless, so reopening the panel
reseeds it.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/projects/:id/ask` | Ask a question. Body: `{ question, history?, agent?, attachment_ids? }`. → `{ answer, session_id, suggestion }`. No `repo_path` → `400`; agent failure → `502`. Persists **both** the user and assistant turns under today's conversation **on completion** (no up-front user turn, so a failed run leaves nothing dangling); survives a client disconnect/panel close (SYM-48). |
| `GET` | `/api/projects/:id/ask/history` | Today's persisted conversation (`{ date, messages }`) to reseed the panel. The panel refetches this on every open (`refetchOnMount: 'always'`) and seeds only from that fresh result, so a reply persisted while it was closed is restored rather than dropped (SYM-48); it also polls while open so a reply that lands after a mid-run reopen appears without re-toggling. |
| `DELETE` | `/api/projects/:id/ask/history` | Reset today's conversation ("new conversation"). → `{ ok: true }` |

### Review — standalone project review (`http/routes/reviews.ts`, mounted under `/api/projects`, SYM-51)

Read-only agent **audit** of a project scope (`docs` / `code` / `ui_ux` / `all`) against the **real
repo** (not a worktree, `plan` mode, `disableWorkflows`). Modeled on Ask but **asynchronous**: the
POST starts a background run and returns `202` immediately; the agent finishes regardless of the
client (no `AbortSignal`). One in-flight run per project; the agent's graded findings are persisted as
draft **issue cards** the user converts into real issues (`createIssue`, severity→priority) —
one at a time, or a whole run's drafts at once as `auto` issues (SYM-66) — or dismisses. A restart
fails any orphaned `running` run at boot.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/projects/:id/reviews` | Start a review. Body: `{ scope, agent? }`. → the `running` `ReviewRun`, **`202`**. Invalid scope → `400`; no `repo_path` → `400`; a review already running → `409`; missing project → `404`. |
| `GET` | `/api/projects/:id/reviews` | Recent batches (newest first) with their findings — `ReviewRunWithFindings[]`. The Review tab polls this while a batch is `running`. |
| `POST` | `/api/projects/:id/reviews/findings/:findingId/convert` | Convert a draft finding into an issue. Body: `{ status: 'todo' \| 'backlog' }`. → `{ issue, finding }`, **`201`**. Type/priority/status mapped from the finding (always `mode: 'manual'`); SYM-78 stamps `source: 'review'` + `source_run_id` (the finding's run) on the issue so the board can group it. Idempotent — a re-convert is `409`. |
| `POST` | `/api/projects/:id/reviews/:runId/convert` | **Batch**-convert a run's still-draft findings in one click (SYM-66). Body: `{ mode?, status?, finding_ids? }` — defaults `mode: 'auto'` (orchestrator-eligible) + `status: 'todo'`; `finding_ids` narrows the set; `mode: 'manual'` / `status: 'backlog'` override. → `{ issues, converted }`, **`201`**. Every created issue is stamped `source: 'review'` + `source_run_id: runId` (SYM-78) so the board groups the whole batch. Idempotent: converted/dismissed findings are skipped (re-clicking only mops up remaining drafts, no duplicates); when ≥1 `auto` issue is created it kicks the orchestrator so they dispatch promptly. Unknown/foreign run → `404`. |
| `PATCH` | `/api/projects/:id/reviews/findings/:findingId` | Set a finding's status. Body: `{ status: 'draft' \| 'dismissed' }` (dismiss / restore). A `converted` finding can't change → `409`. |
| `DELETE` | `/api/projects/:id/reviews/:runId` | Delete a batch (cascades its findings; converted issues are untouched). → `204`. |

---

## Issues — `/api/issues` (`http/routes/issues.ts`)

### CRUD & detail

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/issues?project_id=&status=` | List issues; both query params optional filters. |
| `POST` | `/api/issues` | Create an issue. Body requires `project_id` + `title`; optional `attachment_ids?` links pre-uploaded files (SYM-35, capped by `max_attachments_per_item`); optional `thinking_effort` (`none`/`think`/`think-hard`/`ultrathink`, SYM-46) sets the per-issue extended-thinking override (omit/`null` ⇒ inherit project ?? engine); optional `enable_workflow_tool` (boolean, SYM-67) sets the per-issue Workflow-tool override (omit/`null` ⇒ inherit project ?? engine). SYM-78: `source`/`source_run_id` are **system-set provenance** — any client-supplied values are stripped, so a hand-created issue is always `source: 'manual'`. → `201` |
| `GET` | `/api/issues/:id` | Full detail: the issue plus `tasks`, `runs`, `events` (latest 200), `relations`, `revisions`. `404` if missing. |
| `PATCH` | `/api/issues/:id` | Update issue fields (status, mode, priority, `attachment_ids`, `thinking_effort`, `enable_workflow_tool`, etc.; pass `thinking_effort:null` / `enable_workflow_tool:null` to clear either back to inherit). Moving to a terminal status mid-run cancels the active run; `cancelled` also cleans up the branch/worktree. |
| `DELETE` | `/api/issues/:id` | Cancel any active run, clean up resources, delete the issue. → `204` (also `204` if already gone). |
| `POST` | `/api/issues/:id/follow-ups` | Create a follow-up issue linked to a **completed** source (`409` if source not `done`). Body requires `title`; `include_context` (default true) carries predecessor context; optional `thinking_effort` and `enable_workflow_tool` carry onto the follow-up. → `201` |

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

## Attachments — `/api/attachments` (`http/routes/attachments.ts`)

Binary file attachments for issues and ask turns (SYM-35). Transport is **multipart + raw bytes**
(not base64-in-JSON — avoids the ~33% inflation). Upload is a **separate step** from issue/ask
creation: the client uploads each file as it is pasted/dropped, holds the returned `id`, and
issue/ask create then carry `attachment_ids` (small JSON) which the server links. An upload may
pre-link to an existing issue via `issue_id` (the edit flow); the new-issue/ask flows upload
unlinked and link on submit.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/attachments` | Upload one file (multipart). → the `Attachment` JSON, `201`. |
| `GET` | `/api/attachments/:id` | Serve the raw bytes; `inline` by default, any truthy `?download` (e.g. `?download=1`) forces a download disposition. `404` if missing. |
| `DELETE` | `/api/attachments/:id` | Delete the blob + row. Idempotent (no-op if already gone). → `204` |

**`POST /api/attachments`** — multipart form fields: `file` (required, binary), `project_id`
(required), `issue_id` (optional — auto-links the upload and enforces the per-issue cap; must belong
to `project_id`). Success → `201` with the `Attachment`
`{ id, project_id, issue_id, ask_message_id, filename, mime, size_bytes, created_at }`
(`ask_message_id` is `null` on a fresh upload). Errors are `{ "error": "<message>" }`:

- `400 "expected multipart/form-data with a file field"` — body is not multipart form data.
- `400 "file is required"` — no `file` field (or it is not a file).
- `400 "file is empty"` — zero-byte file.
- `413 "file too large — max <max_attachment_bytes> bytes"` — exceeds the byte cap (Payload Too Large).
- `400 "project_id is required"` / `400 "project not found"`.
- `400 "issue not found"` / `400 "issue does not belong to project"` — only when `issue_id` is supplied.
- `400 "too many attachments (max <max_attachments_per_item>)"` — the per-issue count cap.

**`GET /api/attachments/:id`** → `200` with the raw bytes and headers: `Content-Type` (the stored
`mime`, else `application/octet-stream`), `Content-Length`, `Content-Disposition`
(`inline`/`attachment` plus `filename*=UTF-8''<encoded>`), and `Cache-Control: private, max-age=3600`
(private but cacheable — an id's bytes never change). Any truthy `?download` value forces the
`attachment` disposition. Missing id → `404 "not found"`.

**Caps** (`core/config.ts`, both settings-table / UI editable): `max_attachment_bytes` (default
10 MB) bounds the upload size → the `413`; `max_attachments_per_item` (default 10) bounds the
per-issue count → the `400 "too many attachments"`.

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

Mostly read-only, computed (no DB). Reads the **local** Claude Code / Codex CLI session logs on the same
machine for the sidebar footer. SYM-39 repurposed this from spent token *usage* to **remaining**
rate-limit quota (the user wants to see what's left). Codex reads its remaining from local rate-limit
logs. Claude persists no quota locally, so SYM-40 has the server fetch it **LIVE**: a single best-effort
`GET <ANTHROPIC_BASE_URL>/api/oauth/usage` using the user's own local OAuth token (headers
`Authorization: Bearer …`, `anthropic-beta: oauth-2025-04-20`) — the same endpoint the CLI's `/usage`
uses. This is the one place the route is **not** strictly no-network; the token is sent only to the
fixed Anthropic host over HTTPS (same trust boundary as Claude Code itself) and is **never logged nor
returned to the client** (only percentages/reset times are). Every fetch failure (no token / expired /
offline / non-200 / parse) degrades to `unsupported` — never an error. Today's token totals are still
computed for the tooltip (and, when Claude falls back to `unsupported`, headlined in the row alongside a
visible `/usage` hint).

**Credential source (read-only, never refreshed/written):** `CLAUDE_CODE_OAUTH_TOKEN` env →
`<root>/.credentials.json` → macOS keychain (`security find-generic-password -s 'Claude Code-credentials'`).
The fetch is skipped when no token is found or `expiresAt` has passed.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/usage/local` | Per-agent remaining quota + today's token totals (`LocalUsageReport`). |

`GET /api/usage/local` → `200 { generated_at, agents }`:

- `generated_at` — ISO timestamp of the snapshot.
- `agents` — one `AgentUsageReport` per agent (`claude`, `codex`), each `{ agent, status, usage, windows?, error? }`:
  - `status`: `ok` (a rate-limit reading succeeded → `windows` populated; Codex from its latest local
    snapshot, Claude from the live fetch), `empty` (Codex: dir found but no recent snapshot),
    `unsupported` (Claude: the live remaining read couldn't run — no local OAuth token / expired /
    offline / endpoint error; run `/login` then `/usage` in the Claude CLI), `not_found` (the CLI's
    data dir doesn't exist — not installed / never run), `error` (LOCAL read failure; `error` carries
    the reason — a failed Claude live fetch is **not** an error, it degrades to `unsupported`).
  - `windows` (either agent, `ok` only) — array of `RateWindow` `{ key, used_percent, remaining_percent,
    window_minutes, resets_at }`. `key` is `primary` (short rolling window — Codex primary / Claude
    `five_hour`, 300 min) or `secondary` (weekly — Codex secondary / Claude `seven_day`, 10080 min);
    `remaining_percent = clamp(0, 100, 100 − used_percent)` (Claude's `used_percent` is the endpoint's
    `utilization`); `resets_at` is epoch **milliseconds** (0 if unknown; Claude's source is an ISO
    string, Codex's epoch seconds). A window whose `resets_at` already passed has rolled over since the
    reading, so it's reported as fully remaining (used 0 / left 100) with `resets_at` projected forward.
  - `usage`: `{ input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens }`,
    summed across **today's** sessions (the tooltip figure). `total_tokens` is the sum of the other four.

**Always `200`** — each agent is read inside its own try/catch, so a missing/locked CLI dir yields a
per-agent `not_found`/`error` row rather than failing the whole request. **"Today" (for the usage
totals) is the server's local-machine day** (Symphony runs locally beside the CLIs). Codex rate-limit
snapshots are scanned across rollouts touched within ~8 days (so the weekly window stays visible);
the today-only usage filter is per-line, so the wider file set doesn't change the usage numbers. The
Claude live fetch is cached for ~30s to coalesce the bursty sidebar polls. Data roots honor
`CLAUDE_CONFIG_DIR` (Claude, may be comma-separated; else `~/.claude` + `~/.config/claude`) and
`CODEX_HOME` (Codex; else `~/.codex`), read at request time.

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
