# Symphony — Architecture

How the system is laid out, how an issue flows through it, and the rationale behind the seams. Every
claim cites a `path:symbol`. For the data layer see [DATA_MODEL.md](DATA_MODEL.md); for the HTTP
surface see [API.md](API.md); for the agent/prompt contract see [AGENT_GUIDE.md](AGENT_GUIDE.md).

## 1. Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite, Tailwind v4, TanStack Query, React Router 7 (`src/web/`) |
| Backend | [Hono](https://hono.dev) on Node, TypeScript run directly via `tsx` (no compile step) |
| Database | `node:sqlite` (WAL mode), a single file under `data/` (`src/server/env.ts:DB_PATH`) |
| Agent runtime | Claude Code (or Codex) CLI subprocess, streaming `stream-json` |

Node 22.5+ is required for the built-in `node:sqlite` (`package.json` `engines`). The server boots via
`tsx` — there is no build artifact for the backend; `npm run build` builds only the client.

## 2. Layered module map

The server is organized so that **the orchestrator is the only authority over scheduling**, and the
agent CLI sits behind a dependency-injection seam. Layers depend downward only.

```
src/server/
  index.ts          Hono entry: opens the DB, mounts /api/* routes, starts the orchestrator
  env.ts            Paths + port + prod flag (DATA_DIR, DB_PATH, DEFAULT_WORKSPACE_ROOT, PORT)

  http/routes/      One file per route group → see API.md
                      projects.ts · ask.ts · issues.ts · ops.ts · usage.ts · stream.ts · fs.ts

  orchestrator/     COORDINATION LAYER — the only mutator of RuntimeState
    orchestrator.ts   dispatch / retry / give-up / quota-suspend / restart recovery; the poll loop
    state.ts          RuntimeState: running / retry / claimed / completed + suspendedUntil
    reconcile.ts      per-tick stall detection + out-of-band status refresh (aborts runs)
    retry.ts          exponential backoff + retry-timer bookkeeping
    worker.ts         thin bridge: runs the pipeline, wires events into stall-detection + SSE

  phases/           EXECUTION LAYER — everything to run ONE issue
    index.ts          runIssuePipeline: the sequencer; persists run rows + events per phase
    types.ts          PhaseContext / PhaseOutcome / PHASE_ORDER / agentInput / runPhaseAgent
    plan.ts implement.ts qa.ts delivery.ts merge.ts   one module per phase (one agent session each)

  agent/            THE DI SEAM between deterministic logic and the non-deterministic CLI
    types.ts          AgentRunner / AgentRunInput / AgentResult / AgentEvent (the contract)
    runAgent.ts       multi-CLI dispatcher (branches on input.agent)
    claudeRunner.ts   spawns `claude --print --output-format stream-json …`
    codexRunner.ts    the Codex CLI equivalent

  core/             Pure-ish helpers shared across layers
    config.ts         EngineConfig + DEFAULT_SETTINGS + NUMERIC_KEYS + resolveConfig
    prompt.ts         ALL prompt assembly + fence parsing + load-bearing role titles
    workflow.ts       WORKFLOW.md YAML loader (per-repo policy)
    projectConfig.ts  verification / promotion / commit_guard config merge
    keys.ts, githubSkill.ts, marketplaceSkill.ts, …

  repo/             DATA-ACCESS LAYER — one file per table, all SQL lives here
                      projects · issues · tasks · runs · revisions · planContext ·
                      notes · projectSkills · events · ask · settings · issueRelations
  db/               schema.ts (idempotent CREATE TABLE) · migrate.ts (additive backfills) · client.ts
  tracker/          localTracker.ts — the Tracker interface backed by the local DB
  workspace/        per-issue git worktrees + git/promotion/verification/skills helpers;
                    docs.ts reads the project repo's documentation for the Docs tab (read-only)
  usage/            localUsage.ts: reads the LOCAL Claude/Codex CLI session logs and aggregates
                    today's tokens for the sidebar footer (read-only; writes nothing) — SYM-38
  observability/    structured logger + in-process event bus (SSE source)
  preview/          launch the project from an issue's worktree (preview server)

src/shared/types.ts  domain types shared by server + client (the single source of view-model truth)
```

**Boundary rules** (enforced by convention + `CLAUDE.md`):

- Nothing outside `orchestrator/` mutates `RuntimeState` (`orchestrator/state.ts:RuntimeState`).
- The orchestrator and phases depend only on `agent/types.ts:AgentRunner`, never on the CLI — so
  tests inject a fake runner (`tests/helpers/fakeRunner.ts`).
- All SQL lives in `repo/`; repo modules return mapped domain types from `src/shared/types.ts`, and
  raw row interfaces stay private to the repo file.
- The orchestrator reaches issues only through `tracker/localTracker.ts:Tracker`, so the source of
  issues (SQLite today, a remote tracker later) is swappable without touching scheduling.

## 3. The issue lifecycle (end-to-end data flow)

```
 Board (React)                         Orchestrator poll loop (orchestrator.ts#tick)
   create issue ─────────────────────▶  reconcile() → (if enabled) fetchCandidates()
   set mode=auto                          status ∈ {todo,in_progress} AND mode=auto, priority-sorted
   — or click Run (POST /:id/run) ──────▶ runNow() bypasses the auto filter
                                            │  dispatch() while free WIP slots remain
                                            ▼
        ┌──────────────── per-issue git worktree (workspace/worktree.ts) ───────────────┐
        │  runIssuePipeline (phases/index.ts):  plan → implement → qa → delivery         │
        │    • one agent session per phase (agent/claudeRunner.ts)                       │
        │    • a run row + activity events persisted per phase (repo/runs, repo/events)  │
        │    • plan emits a task checklist + planning context, carried into implement    │
        │  then objective verification commands (if configured) run in the worktree      │
        └───────────────────────────────────┬────────────────────────────────────────────┘
                                             ▼
        require_review (or PR mode)?  ── yes ─▶ status = review  ── human ──┬─ approve  ─▶ merge/PR ─▶ done
                                      ── no  ─▶ merge phase pushes branch ─▶ done         └─ request changes ─▶ round+1 ─▶ todo
        any phase failure ─▶ orchestrator: retry w/ backoff → give up to manual after max_attempts
```

Step by step (`phases/index.ts:runIssuePipeline`):

1. **Prepare the worktree.** Resolve base branch + agent branch, create/reuse the worktree
   (`workspace/worktree.ts:ensureWorktree`, which enforces the two safety invariants), install the
   commit-guard hook if enabled, and persist `branch_name` / `worktree_path` on the issue. Enabled
   project skills are materialized into `.claude/skills/`.
2. **Resolve round + cross-run context.** The current `round` selects round-scoped run queries;
   round ≥ 2 carries the human's "request changes" feedback. Prior-failure context, recent project
   notes, and predecessor-story context are gathered for the prompts.
3. **Sequence the phases** in `PHASE_ORDER = ['plan','implement','qa','delivery']`
   (`phases/types.ts:118`). For each phase: skip it if a round-scoped successful run already exists
   (`skipCompletedPhase`), otherwise create a run row, run the phase's one agent session, persist
   usage + events, and finish the run. Plan parses a `symphony-plan` JSON fence into tasks +
   planning context; QA parses a `QA_RESULT: PASS|FAIL` verdict; delivery's whole reply is the
   user-facing summary (best-effort — a failed delivery never blocks the gate).
4. **Objective verification.** If `verification.commands` are configured, run them in order inside the
   worktree; every command must exit 0 and leave the tree clean, or the issue retries/parks per
   `on_failure`. This objective result — not the self-QA verdict — is the gate.
5. **Distill a learning.** The implement report is summarized into a project note for future prompts.
6. **Terminal transition.** If `require_review` is on (or promotion is PR mode) the issue parks at
   `review`. Otherwise the autonomous path runs a `merge` phase that pushes the branch + integrates it
   on the remote, then marks the issue `done`.

The orchestrator decides what happens on the *outcome* (success / retry / park) — see §4.

## 4. The orchestrator: tick loop + runtime state

`orchestrator/orchestrator.ts:Orchestrator` is the single scheduling authority (Symphony spec §7–8).
It owns a poll loop and the in-memory `RuntimeState`; workers report outcomes back to it, and nothing
else mutates that state.

### The tick (`Orchestrator#tick`)

Runs every `poll_interval_ms` (default 30 s) and never overlaps itself (`ticking` guard):

1. `reconcile(state, tracker, stall_timeout_ms)` — see §5.
2. If the engine is disabled (`enabled=false`), stop here.
3. Clear an expired global suspension; if still suspended (e.g. an agent quota limit), stop here.
4. Pull `tracker.fetchCandidates()` (active status + `mode=auto`, priority-sorted) and `dispatch()`
   each one while free WIP slots remain (`availableSlots = wip_limit − running.size`), skipping any
   issue already claimed or running.

`kick()` forces an immediate tick (backs `POST /api/ops/snapshot/kick`). `runNow(issueId)` dispatches
one issue immediately regardless of mode (backs the manual "Run" button), superseding a queued retry
and ignoring the global suspension *for that one issue only*.

### Dispatch → outcome (`dispatch` / `handleOutcome`)

`dispatch()` claims the issue, flips its status to `in_progress` **synchronously before** the entry
joins `running` (so a concurrent reconcile can't mistake a just-dispatched run for a stalled/ineligible
one), registers a `RunningEntry` with an `AbortController`, and calls
`executeIssue` (`orchestrator/worker.ts`). When the pipeline resolves, `handleOutcome` decides:

- **Success, or the issue went terminal mid-run** → mark completed, release the claim.
- **Park requested** (verification `on_failure: park`) → set `mode=manual`, release.
- **Quota error** → `suspendUntil(...)` pauses the *whole queue*, and the issue is re-queued for when
  the suspension lifts. Quota failures do **not** burn an attempt.
- **Failure with `attempt ≥ max_attempts`** → give up: set `mode=manual`, release.
- **Failure otherwise** → `scheduleRetry` with exponential backoff (`retry.ts:backoffMs` =
  `min(10000·2^(attempt−1), max_retry_backoff_ms)`); `onRetryDue` re-dispatches when the timer fires,
  unless the issue left an active status, the queue is still suspended, or no slots are free.

### Restart recovery (`recover`)

On `start()`, run rows left in `running` (from a dead process) are closed out as `cancelled`
(`repo/runs:listDanglingRuns` + `finishRun`). Issues stuck `in_progress` + `auto` are simply
re-picked-up by the normal poll loop — no special handling.

### RuntimeState (`orchestrator/state.ts:RuntimeState`)

The single authoritative in-memory scheduling state. Sets/maps:

| Field | Meaning |
|-------|---------|
| `running: Map<id, RunningEntry>` | issues with a live agent pipeline (carries the `AbortController`, attempt, timing, last-event time) |
| `retry: Map<id, RetryEntry>` | issues with a queued retry timer (attempt it will run as, `dueAt`, the timer, last error) |
| `claimed: Set<id>` | reservation so an issue isn't double-dispatched while running **or** while a retry is queued |
| `completed: Set<id>` | issues that finished this process lifetime |
| `suspendedUntil` / `suspendedReason` | a queue-wide pause (e.g. agent quota); new dispatches blocked until it lifts (a manual Run overrides per-issue) |
| `endedSeconds` | cumulative wall-clock of ended sessions, for the Ops totals |

`snapshot()` derives the Ops view model (`src/shared/types.ts:Snapshot`): per-issue running rows with
phase + tokens read from DB run rows, queued retries, token totals, the poll interval, the WIP limit,
the enabled flag, and any still-active suspension.

## 5. Reconciliation & resilience

`orchestrator/reconcile.ts:reconcile` runs at the top of every tick and only *aborts* runs (the
worker's completion handler decides retry):

- **A. Stall detection.** If `stall_timeout_ms > 0` and a running entry has produced no events for
  longer than the timeout (`lastEventAt`, refreshed by `worker.ts` on every persisted event), abort
  it. Each persisted event resets the activity clock via `state.markEventActivity`.
- **B. Status refresh.** For each running issue, re-read it through the tracker; if it was removed, is
  terminal, or is no longer exactly `in_progress` (cancelled/finished out-of-band), abort it.

Resilience features at a glance:

| Concern | Mechanism | Source |
|---------|-----------|--------|
| Bounded concurrency | WIP limit gates dispatch | `orchestrator.ts:availableSlots` |
| Transient failure | exponential-backoff retry | `retry.ts:backoffMs`, `scheduleRetry` |
| Permanent failure | give up → `mode=manual` after `max_attempts` | `orchestrator.ts:handleOutcome` |
| Wedged session | stall detection aborts after `stall_timeout_ms` | `reconcile.ts` |
| Runaway cost | per-phase wall-clock cap + `--max-turns` | `config.ts:phase_timeout_ms`, `max_turns` |
| Agent quota limit | queue-wide suspension; attempts not burned | `orchestrator.ts` (`errorKind==='quota'`) |
| Out-of-band cancel | reconcile aborts; `cancelIssue` on delete/cancel | `reconcile.ts`, `orchestrator.ts:cancelIssue` |
| Process restart | close dangling runs; re-pick active issues | `orchestrator.ts:recover` |

## 6. The agent DI seam

`agent/types.ts:AgentRunner` is the single boundary between deterministic logic and the
non-deterministic, token-spending CLI:

```ts
type AgentRunner = (input: AgentRunInput, onEvent?: (e: AgentEvent) => void) => Promise<AgentResult>
```

- **Production** (`agent/runAgent.ts:runAgent`) is a dispatcher that branches on `input.agent` to the
  Claude or Codex runner — the choice of CLI is *data on the input*, not a wiring decision.
- **Tests** inject `tests/helpers/fakeRunner.ts:makeFakeRunner`, which detects the phase from the
  prompt and returns canned, well-formed output (plan JSON, a real file write, a QA verdict, a
  delivery summary, a merge verdict) — no tokens, no CLI. This is why `npm test` can drive the *real*
  pipeline + orchestrator offline against a throwaway repo and SQLite DB.

A runner **never throws for agent-level failures** — it resolves with `ok:false` (and optionally
`errorKind:'quota'` + `retryAfterMs`) so the orchestrator owns all retry policy. See
[AGENT_GUIDE.md](AGENT_GUIDE.md) for the phase/role/prompt contract on top of this seam.

## 7. Configuration & precedence

Effective engine config is layered (`core/config.ts`, `core/workflow.ts`, `core/projectConfig.ts`):

```
built-in defaults (config.ts:DEFAULT_SETTINGS)
  → settings table (UI Settings page, repo/settings.ts)
  → per-project overrides (project.model + project.config JSON)
  → per-repo WORKFLOW.md (front-matter YAML, read fresh per run)
```

For agent-run fields specifically, the resolution in `phases/types.ts:agentInput` is
**WORKFLOW.md → per-project → engine config** (the agent CLI is resolved first because it selects the
binary + default model). Prompt additions from per-project config and `WORKFLOW.md` are *appended* to
the built-in professional-team prompt, never replacing it. Default values are tabulated in the root
[README.md](../README.md) Configuration section and listed in [DATA_MODEL.md](DATA_MODEL.md) §settings.

## 8. Frontend (overview)

`src/web/` is a React 19 SPA (Vite + Tailwind v4 + TanStack Query + React Router 7). It talks only to
`/api/*` (REST + SSE; the dev server proxies to the Hono server on `:3030`). Pages (`src/web/pages/`):

- **Projects.tsx** — project list + create (with the `fs` directory picker for `repo_path`).
- **Board.tsx** — the Linear-style issue board per project (status columns, create/run, conflict
  badges).
- **IssueDetail.tsx** — one issue: live activity stream (SSE), run history, diff, the review-gate
  actions (approve / request changes / resolve conflict), and the delivery summary.
- **Ops.tsx** — orchestrator snapshot, token totals, and run history.
- **Settings.tsx** — the engine `settings` table editor.
- **ProjectAgent.tsx / ProjectSkills.tsx** — per-project policy (`config` JSON) and project skills.
- **StoryTree.tsx** — the per-project story forest folded from `issue_relations` (SYM-30).
- **Documentation.tsx** — the Docs tab (SYM-36): a master/detail reader over the repo's docs. The
  file sidebar + reading pane are backed by `GET /:id/docs` and `GET /:id/docs/content`, which read the
  allow-listed text/markdown files under `config.docs.directories` (default `['docs']`) via
  `workspace/docs.ts`; an inline editor adds/removes directories by PATCHing `config.docs`.

The left sidebar (`components/Layout.tsx`) ends in a footer widget, **`SidebarUsage.tsx`** (SYM-38),
that shows today's local Claude Code / Codex token usage from `GET /api/usage/local`. It refreshes on
a 60s interval and whenever any issue takes an action — the latter by observing the shared
`['issues']` poll (Layout already runs it every 3s) and invalidating the usage query when the issues'
status/`updated_at` signature changes. It renders every state: loading, `ok` (compact token figure),
`empty`, `not_found`, and `error` → "检测失败".

The frontend is documented at module level only; its components are not part of the server contract.

## 9. Design rationale

Why the seams are where they are:

- **No god files.** The predecessor's ~1000-line execution module is split into per-phase modules + a
  sequencer (`phases/`), and the scheduler is split into `state` / `reconcile` / `retry` / `worker` /
  `orchestrator`. Each file has one job.
- **DI over module-mutation seams.** The agent runner is a *parameter*, not a globally-swapped module,
  so the entire pipeline + scheduler are exercisable offline with one injected fake — no `__setRunner`
  hooks, no network.
- **The tracker is an interface.** The orchestrator never knows issues come from SQLite; a Linear (or
  other) adapter could replace `localTracker.ts` without touching scheduling.
- **One scheduling authority.** Centralizing every state transition in the orchestrator (and forbidding
  anyone else from mutating `RuntimeState`) is what makes concurrency, retries, and recovery reasoned
  about in one place instead of scattered across request handlers.
- **Prompt = the quality floor.** Quality is enforced in prompt text held to a shared bar, not in
  bespoke per-task code, so it applies uniformly and repos can only sharpen it (see AGENT_GUIDE).
- **Idempotent schema, no migration tool.** Single-user + hand-rolled SQLite means `CREATE TABLE IF
  NOT EXISTS` on every boot plus additive `ALTER TABLE` backfills — deliberately simple, with no
  down-migrations (see [DATA_MODEL.md](DATA_MODEL.md)).

## 10. Glossary

| Term | Definition | Source |
|------|------------|--------|
| **Orchestrator** | the single authority over scheduling and issue state transitions | `orchestrator/orchestrator.ts` |
| **RuntimeState** | the single in-memory scheduling state (running/retry/claimed/completed/suspension) | `orchestrator/state.ts` |
| **Tick** | one poll-loop pass: reconcile, then dispatch candidates within the WIP limit | `orchestrator.ts:tick` |
| **Pipeline** | the execution of one issue end-to-end across its phases | `phases/index.ts:runIssuePipeline` |
| **Phase** | one agent session (`plan`/`implement`/`qa`/`delivery`/`merge`) | `phases/types.ts:RunPhase`, `PHASE_ORDER` |
| **Round** | a revision cycle; round 1 = first build, N≥2 = re-run after "request changes" | `issues.round`, `prompt.ts:issueBrief` |
| **Run** | one persisted attempt at one phase of one round (a row in `runs`) | `repo/runs.ts`, `db/schema.ts` |
| **Attempt** | the orchestrator's retry counter for a dispatch (distinct from round) | `orchestrator.ts:dispatch` |
| **Claim** | a reservation preventing double-dispatch while running or retry-queued | `state.ts:claim/release` |
| **AgentRunner** | the DI contract for a single agent session | `agent/types.ts` |
| **Tracker** | the interface the orchestrator reads issues through | `tracker/localTracker.ts:Tracker` |
| **Worktree** | the isolated git checkout one issue's agents run inside | `workspace/worktree.ts` |
| **Review gate** | the single human approve/request-changes decision point | `http/routes/issues.ts` |
| **Verification** | objective per-project commands that gate `review`/`done` | `workspace/verification.ts`, `core/projectConfig.ts` |
| **Promotion** | how approved work lands: direct-merge or pull-request | `core/projectConfig.ts:PromotionConfig` |
| **WORKFLOW.md** | optional per-repo policy (YAML front matter), read fresh per run | `core/workflow.ts` |
| **Suspension** | a queue-wide pause, typically an agent quota limit | `state.ts:suspendUntil` |
