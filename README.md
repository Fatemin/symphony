# Symphony (Claude Code edition)

A local, ground-up implementation of OpenAI's **[Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)**
orchestration concept — but with **Claude Code CLI** in place of Codex, and a **built-in issue
tracker** in place of Linear.

You manage *work*, not coding agents. Create issues on a Linear-style board; a long-running
orchestrator picks up issues, runs a coding agent against each one in an **isolated git worktree**,
self-QAs the result, and parks it at a single human-review gate. Bounded concurrency, retries with
backoff, stall detection, and restart recovery are all handled by one authoritative scheduler.

> Replaces the messier `agile-with-agent` prototype with a cleanly-layered rebuild: no god files,
> a 12-table schema, the agent runner behind a dependency-injection seam, and the whole pipeline
> testable offline.

---

## Documentation

This README is the user-facing "how it works" guide. For the deep reference layer, see
[`docs/`](docs/):

- [docs/PRD.md](docs/PRD.md) — product vision, the "manage work, not agents" model, scope, success criteria.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layered module map, the issue lifecycle, the orchestrator tick loop + runtime state, design rationale, glossary.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — every table, the additive-migration convention, and the status / mode / round state machine.
- [docs/API.md](docs/API.md) — the HTTP + SSE endpoint reference.
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — the contract for agents/contributors: phases, load-bearing role titles, prompt assembly, policy, and how to extend.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — LAN access (no auth required), the optional shared-token gate, where agents actually run, and the `bypassPermissions` exposure premise.

---

## How it works

```
 Board (React)                     Orchestrator (poll loop)
   create issues  ──────────────▶  reconcile → validate → fetch candidates
   set mode=auto                     │  (status active + mode=auto, priority-sorted)
                                     ▼
                         dispatch (bounded by WIP limit)
                                     │
                                     ▼
                  ┌──────────── per-issue git worktree ───────────┐
                  │  plan → implement → qa → delivery             │
                  │  one Claude session each: tech lead,          │
                  │  engineer, QA verdict, user-facing wrap-up    │
                  └───────────────────────┬───────────────────────┘
                                          ▼
                        QA PASS → status = review  ──▶  human approves ──▶ done
                        any failure → retry w/ backoff (give up → manual)
```

- **Orchestrator** ([src/server/orchestrator/](src/server/orchestrator/)) is the single authority over
  scheduling — it owns the in-memory runtime state and every transition (dispatch / retry / release /
  give-up). It follows the Symphony spec's §7–8 state machine.
- **Agents run via the Claude Code CLI**, spawned as `claude --print --output-format stream-json …`
  ([src/server/agent/claudeRunner.ts](src/server/agent/claudeRunner.ts)). Agents use the CLI's own
  tools (Read/Write/Edit/Bash) and the CLI's own authentication — no API key is stored here.
- **Isolation:** every issue gets its own `git worktree` under `workspace_root`
  ([src/server/workspace/worktree.ts](src/server/workspace/worktree.ts)). Agents never touch the main
  checkout. Two safety invariants are enforced: the agent's `cwd` must be the worktree, and the
  worktree must resolve inside `workspace_root`.
- **Native context:** Claude Code reads the target repo's own `CLAUDE.md` / `AGENTS.md`, so there's no
  bespoke context-injection system — just an optional per-project context note appended to prompts.
  A good `CLAUDE.md` in the target repo is the cheapest way to cut agent exploration turns (and
  tokens) — keep one there.
- **The pipeline** ([src/server/phases/](src/server/phases/)) is the whole execution layer for one
  issue: `plan → implement → qa → delivery`, one small module per phase plus a sequencer that persists
  a run row and activity events per phase. The final `delivery` phase writes a user-facing summary of
  the round (what shipped, how to use it, which files/docs changed) in the same language the requester
  used to write the issue; it is best-effort, so a failed summary never blocks the review gate.
- **Planning context is carried forward.** The plan phase saves a compact file map and implementation
  context for the issue, so the implement phase can start from the planner's exploration instead of
  rediscovering the same files.
- **Agents are prompted as a professional team.** Every phase prompt holds its role to one shared
  quality floor, assembled in [src/server/core/prompt.ts](src/server/core/prompt.ts): the **tech
  lead** plans architecture, non-functional, and UX up front; the **implementing engineer** ships a
  polished, accessible change *and* updates every affected doc; the independent **QA engineer**
  re-checks each acceptance criterion, regressions, and that docs match the new behavior; the
  **release engineer** publishes the branch. The planner emits a checklist whose tasks carry a role —
  `impl`, `qa`, `frontend`, `backend`, `docs`, `delivery` (a handoff/summary task run inside the
  implement phase), or `other`. A repo's `WORKFLOW.md` and per-project prompt additions only *append*
  to this floor, never replace it.

### Status model

| Status | Meaning |
|--------|---------|
| `backlog` | Not scheduled |
| `todo` | Scheduled; eligible for the orchestrator (when `mode=auto`) |
| `in_progress` | An agent pipeline is running |
| `review` | Agent work + self-QA done; **awaiting a human to approve** (the one gate) |
| `done` | Terminal — approved |
| `cancelled` | Terminal — abandoned |

`todo`/`in_progress` are **active** (the orchestrator acts on them); `review` is the **human gate**;
`done`/`cancelled` are **terminal**. The review gate is per-issue (`require_review`, default on) —
turn it off and a passing issue goes straight to `done`.

---

## Quick start

### Prerequisites

- **Node.js 22.5+** (uses the built-in `node:sqlite`, no native build step).
- **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code)** installed and authenticated
  (`claude` on PATH, or `claude.cmd` on Windows).
- A target project that is a **local git repository** — agent runs create worktrees from it.

### Install & run

```bash
npm install
npm run dev      # Hono server (:3030) + Vite client (:5173) together
```

Open the Vite URL it prints. The client proxies `/api/*` (REST + SSE) to the server. Then:

1. **Projects → New project**, pointing `repo_path` at a local git repo.
2. **New issue**, fill in a title + acceptance criteria.
3. Click **Run** (manual) — or set the issue to **auto** and let the orchestrator pick it up.
4. Watch the live activity stream on the issue page; **Approve** when it reaches `review`.

`npm run seed` creates a demo project + a couple of issues to look at.

### Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Server + client together (dev) |
| `npm run dev:server` / `dev:web` | One side only |
| `npm run build` | Build the client to `dist/` |
| `npm start` | Production: serve the built client from the Hono server on `PORT` (default 3030) |
| `npm test` | **Offline** end-to-end tests (no CLI, no tokens) |
| `npm run lint` | Type-check client + server |
| `npm run seed` | Insert a demo project + issues |

---

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | React 19, Vite, Tailwind v4, TanStack Query, React Router 7 |
| Backend | Hono on Node, TypeScript via `tsx` (no compile step) |
| Database | `node:sqlite` (WAL), single file at `data/symphony.db` |
| Agent runtime | Claude Code CLI subprocess, streaming `stream-json` |

```
src/server/
  db/          node:sqlite connection + idempotent schema + seed
  repo/        thin data-access layer — one file per table (no SQL leaks into logic)
  core/        config, prompt assembly, WORKFLOW.md loader, key/id helpers
  agent/       Claude CLI runner + normalized AgentEvent types (the DI seam)
  workspace/   per-issue git worktrees + git helpers
  phases/      plan / implement / qa / delivery + the per-issue sequencer (Execution layer)
  orchestrator/ state · reconcile · retry · worker · orchestrator (Coordination layer)
  tracker/     Tracker interface backed by the local DB (swap in Linear later, untouched orch)
  http/        Hono routes + SSE stream
  observability/ structured logger + live event bus
src/web/       React board (Projects, Board, IssueDetail, Review, StoryTree, Documentation, Ops, Settings)
src/shared/    domain types shared by server + client
tests/         offline pipeline + orchestrator tests with an injected fake runner
```

Design choices that fix the previous prototype's rough edges:

- **No god files.** The old 1066-line `execution.ts` is split into per-phase modules + a sequencer;
  the scheduler is split into `state` / `reconcile` / `retry` / `worker` / `orchestrator`.
- **DI over module seams.** The agent runner is a parameter (`AgentRunner`), so tests inject a fake —
  no global `__setRunner` hooks. The whole pipeline + scheduler run offline against a throwaway repo.
- **The tracker is an interface.** The orchestrator never knows the issues come from SQLite; a Linear
  adapter could replace [localTracker.ts](src/server/tracker/localTracker.ts) without touching it.

---

## Configuration

### Environment variables

Process-level config (read at startup) lives in the environment, not the `settings` table. The
network/auth vars (SYM-42) are deliberately env-only — the token must never reach the config API.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `localhost` | Interface the server binds to. Defaults to localhost; set `0.0.0.0` (or a specific IP) for LAN access — no token required (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). |
| `PORT` | `3030` | Server port. |
| `SYMPHONY_AUTH_TOKEN` | *(unset)* | **Optional** shared secret that turns on the minimal access-control middleware. Unset ⇒ no auth. |
| `SYMPHONY_WEB_HOST` | *(unset)* | Vite dev-server bind. `true` = all interfaces, or a literal host. Dev only. |
| `SYMPHONY_DATA_DIR` | `./data` | Root for the SQLite DB + attachment blobs. |
| `SYMPHONY_DB_PATH` | `<DATA_DIR>/symphony.db` | Explicit SQLite file path (overrides the default under `DATA_DIR`). |
| `SYMPHONY_WORKSPACE_ROOT` | `<tmp>/symphony_workspaces` | Where per-issue git worktrees are created. |

With none set the server binds `localhost` with no auth — exactly the historical single-user behavior.

### Engine configuration

Effective engine config = **built-in defaults** → **`settings` table** (edited on the Settings page) →
**per-project overrides** (`model`, `context`, plus optional project `config` JSON edited from the
project's **Agent** tab) → **optional per-repo `WORKFLOW.md`**. Key engine fields:

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `true` | Master switch for auto-dispatch |
| `enable_workflow_tool` | `false` | Allow pipeline agents to use Claude Code's Workflow tool. Off keeps the orchestrator the sole scheduler (no agent-spawned background runs) |
| `model` | `claude-sonnet-4-6` | Model passed to the CLI |
| `permission_mode` | `bypassPermissions` | CLI permission mode for headless runs |
| `wip_limit` | `3` | Max concurrent issue runs |
| `poll_interval_ms` | `30000` | Orchestrator tick cadence |
| `phase_timeout_ms` | `1200000` | Wall-clock cap per phase |
| `stall_timeout_ms` | `300000` | Abort a run after this long with no agent events |
| `max_turns` | `120` | CLI `--max-turns` per phase (`0` disables the cap) |
| `thinking_effort` | `none` | Extended-thinking keyword appended to pipeline prompts (`none`/`think`/`think-hard`/`ultrathink`) |
| `max_attempts` | `3` | Give up + park to `manual` after this many failures |
| `workspace_root` | `<tmp>/symphony_workspaces` | Where worktrees live |

**`WORKFLOW.md`** (optional, in a target repo): YAML front matter can override `agent.model`,
`agent.permission_mode`, `agent.max_turns` (a single number or a per-phase `{plan, implement, qa,
delivery, merge}` map), and append phase-specific guidance under
`prompts.{plan,implement,qa,delivery,merge}`. These prompt additions are *appended* to Symphony's
built-in professional-team prompt for that phase — they sharpen the baseline with repo conventions,
they do not replace it. See
[WORKFLOW.example.md](WORKFLOW.example.md). It is read fresh per run, so edits apply to future runs.

Use `WORKFLOW.md` for stable environment knowledge: test commands, package manager preferences,
virtualenv paths, and install/cache hints such as `npm install --prefer-offline`. Symphony also seeds
new worktrees with a best-effort local clone of the source checkout's `node_modules` when present.

Per-project policy is opt-in and can be stored in the project row's `config` JSON or in
`WORKFLOW.md` front matter:

```yaml
agent:
  permission_mode: bypassPermissions
  max_turns:
    implement: 160
  # SYM-41 execution controls — project config only (NOT WORKFLOW.md), edited from the Agent tab.
  # Omit either to inherit the engine default.
  enable_workflow_tool: false # allow the Workflow tool (self-spawned background runs); default off
  thinking_effort: none # none | think | think-hard | ultrathink

prompts:
  plan: |
    Keep the checklist short and call out risky files.
  implement: |
    Run the repo's fast test target before final output.
  qa: |
    Treat type errors as a hard fail.

verification:
  commands:
    - command: npm test
      cwd: .
      timeout_ms: 120000
      on_failure: retry # or park

promotion:
  mode: pull-request # default: direct-merge
  base_branch: testing
  remote: origin
  auto_merge: false
  push: true # direct-merge only; default: true — push the base to `remote` after approve so CI fires

commit_guard:
  enabled: true # default: false
  blocked_untracked_globs:
    - "*_TEMP.*"
    - "scratch*.md"
```

The React UI exposes these project-level knobs under each project via tabs: **Board**, **Agent**,
**Review**, **Story Tree**, **Docs**, and **Skills**; the left sidebar can expand a project directly
to a view. The **Review** tab (SYM-51) runs a standalone, read-only agent audit of a chosen scope
(docs, code, UI/UX, or all) and surfaces its graded findings as draft issue cards you can convert to
issues or dismiss. The **Docs** tab (SYM-36) renders the repo's documentation — Markdown is themed, other allow-listed
text shows as plain text — and lets you add/remove the source directories it reads (default `docs`,
stored in `config.docs.directories`). `WORKFLOW.md` still wins for agent runtime fields and is
appended after project prompt additions, keeping repo-versioned policy authoritative.

With `verification.commands` configured, Symphony runs the commands in order inside the issue
worktree after implementation/QA. Every command must exit 0 and leave the worktree clean before the
issue can reach `review` or `done`; failures include captured stdout/stderr in events and either
retry or park the issue based on `on_failure`. The self-QA verdict remains visible as an auxiliary
signal, but the objective verification result is the gate.

With `promotion.mode: pull-request`, approval rebases the agent branch onto the configured base,
reruns verification, pushes the branch, and opens a GitHub PR with `gh`. Symphony does not directly
merge in this mode unless `promotion.auto_merge` is enabled and GitHub reports checks/reviews ready.
The default remains the existing local `direct-merge` path for projects without remotes or CI.
At approval time the UI can override the target branch for one or many review stories, create the
target branch from the story's current base when needed, and save that target as the project's new
default branch.

In `direct-merge` mode, approval merges into the base locally and then — with `promotion.push`
(default `true`) — pushes the base to `promotion.remote` so the merge reaches GitHub and Actions
fire. The push is skipped automatically when no such remote is configured, so local-only repos keep
working unchanged; set `push: false` to force local-only behaviour even when a remote exists. Before
pushing, Symphony fetches the remote base and only fast-forwards it; if the remote base has diverged
the approve fails with a clear reason (and an `approve.failed` event) and the issue stays in
`review` — the local merge already landed, so a re-approve retries the push once the remote is
reconciled.

When an approval can't be integrated — a local merge conflict (agent branch vs. its base) or a
diverged-remote push — Symphony decorates the parked issue with a **git conflict** marker: a red
badge on the board card and a banner on the issue page (SYM-29). The banner's **Resolve conflict**
button re-runs the merge and, for a diverged remote, reconciles it agent-side: it fetches the remote
base, merges it into the local base in a throwaway integration worktree (running the same
conflict-resolution agent on any real conflicts), then pushes and marks the issue done. The marker
clears on a successful resolve, and also when **Request changes** starts a new revision round (it is
stale once the branch is rebuilt).

With `commit_guard.enabled`, Symphony installs a pre-commit hook in each issue worktree. Manual
commits are blocked, Symphony stages only explicit diff-derived paths, configured scratch globs are
rejected, and optional `max_files` / `max_bytes` limits can require `override_limits: true`.

---

## Testing

`npm test` runs Node's built-in test runner over an **offline** end-to-end pipeline. The only
non-deterministic, token-spending dependency — the Claude CLI — is replaced by an injected fake
runner ([tests/helpers/fakeRunner.ts](tests/helpers/fakeRunner.ts)) that returns well-formed plan
JSON, writes a real file, emits a QA verdict, and returns a delivery summary. Everything else runs
for real against a throwaway git repo + isolated SQLite DB:

- **pipeline.test.ts** — drives one issue `todo → plan → implement → qa → delivery → review`,
  asserting the worktree, the committed file, the task checklist, the run rows (including the
  delivery summary), and the status transitions.
- **orchestrator.test.ts** — boots the real orchestrator, lets its poll loop pick up an `auto` issue,
  drives it to `review`, human-acks to `done`, and asserts a terminal issue is never re-dispatched;
  plus the give-up-after-max-attempts path.

The real CLI path is intentionally out of `npm test` (slow, costs tokens, needs CLI auth) — exercise
it from the UI or the `POST /api/issues/:id/run` endpoint.

---

## Safety posture

Headless runs default to `bypassPermissions`: there is no human at the CLI to answer per-command
prompts, so agents act freely **inside their isolated worktree** — a real checkout on your machine,
not a sandbox. Human control lives at the **review gate**, not per command. Switch `permission_mode`
to `acceptEdits` to keep agents on the file-edit rail (at the cost of stalling on shell/`git` steps).

**Network exposure (SYM-42, relaxed in SYM-44).** Agents execute arbitrary commands — and they run on
the machine hosting the **backend**, not the LAN client that opened the UI (the client is browser-only;
the orchestrator spawns the CLI via `child_process.spawn` in the server process). The server still
binds `localhost` by default so an install never exposes itself on upgrade. To reach the UI from another
LAN device, set `HOST=0.0.0.0` — that's the only required change; **no token is required** (a non-loopback
bind without a token now starts with a one-line warning instead of refusing). On an untrusted network you
can opt into hardening with `SYMPHONY_AUTH_TOKEN=<secret>`, which enables a minimal shared-token gate
(HTTP Basic / Bearer / `?token=`) in front of every `/api` route and the SPA, with `GET /api/health`
exempt. There is no TLS — Symphony serves plain HTTP, so terminate TLS at a reverse proxy if
confidentiality matters. Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Data & privacy

Only Symphony's framework code is version-controlled. Everything Symphony *manages* stays outside git:

| Lives outside git | Where | Why |
|-------------------|-------|-----|
| SQLite DB — issues, ask transcripts, settings | [`data/symphony.db`](#configuration) (`DATA_DIR`) | Your tracker contents are private project data, not framework code |
| Uploaded attachments | `data/attachments/` (`ATTACHMENTS_DIR`) | Same — durable blob store, never the ephemeral worktree |
| Per-issue git worktrees | `workspace_root` (a tmpdir, default `<tmp>/symphony_workspaces`) | Checkouts of *your* repos, not this one |
| Local agent / editor config | `.claude/settings.local.json`, `WORKFLOW.md`, `.vscode/`, `.idea/` | Per-machine, not shared project config |
| Secrets | `.env`, `*.local` | Credentials |

Agent **conversation transcripts** live in the user's home directory (`~/.claude/projects/...`), never
inside this repository, so they can't enter git. The repo's own [`.gitignore`](.gitignore) — not a
machine-global `core.excludesFile` — encodes every rule above, so the boundary holds for any clone,
CI run, or collaborator. The full git history has never contained DB files, attachments, secrets, or
transcripts; this is the framework, not your data.

## Known limitations

- Single-user by design; LAN access binds via `HOST` with an **optional** shared-token / Basic-auth gate, not multi-tenancy (no accounts, roles, rate limiting, or TLS — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- Hand-rolled schema (idempotent `CREATE TABLE`), no migration tool or down-migrations.
- Worktrees persist after success (by design) and aren't auto-garbage-collected.
- `WORKFLOW.md` is read per run, not file-watched.
