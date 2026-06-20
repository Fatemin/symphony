# Symphony — Data Model

The authoritative reference for Symphony's persistence layer. The single source of truth for the
schema is [`src/server/db/schema.ts`](../src/server/db/schema.ts) (`SCHEMA`); additive backfills live
in [`src/server/db/migrate.ts`](../src/server/db/migrate.ts). All SQL lives in
[`src/server/repo/`](../src/server/repo/) (one file per table), which maps rows to the domain types in
[`src/shared/types.ts`](../src/shared/types.ts).

## Storage & conventions

- **Engine:** `node:sqlite` (Node 22.5+ built-in), WAL mode, a single file at
  `data/symphony.db` (`src/server/env.ts:DB_PATH`; override with `SYMPHONY_DB_PATH`).
- **IDs:** opaque `TEXT` primary keys (nanoid), not autoincrement integers.
- **Timestamps:** ISO-8601 UTC strings via `strftime('%Y-%m-%dT%H:%M:%fZ','now')` defaults.
- **JSON-in-TEXT:** several columns hold JSON encoded as text (e.g. `issues.labels`,
  `issues.merge_conflict`, `projects.config`, `events.data`) — parsed/serialized in the repo layer.
- **Foreign keys:** `PRAGMA foreign_keys = ON`; most child rows `ON DELETE CASCADE` from their parent.

### The migration convention (no migration tool)

There is **no migration framework and no down-migrations** (a deliberate single-user choice). Instead:

1. **`db/schema.ts` is idempotent.** Every statement is `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS`, so `bootstrap(db)` (`db/migrate.ts`) runs the whole schema on every
   boot safely.
2. **Additive column changes are best-effort `ALTER TABLE … ADD COLUMN`** in `db/migrate.ts`
   (`addColumn`), which swallows *only* the "duplicate column name" error and re-throws anything else
   (a locked/readonly DB must stay loud). This backfills columns onto DBs created before the column
   existed.
3. **One-off value backfills** are gated by a marker row in `settings` so they run exactly once per DB
   (e.g. `backfillMaxTurns` moved the seeded `max_turns` 60 → 120; `backfillCancelledAbortedRuns`
   re-classified old human-cancelled runs). `seedSettings` inserts `DEFAULT_SETTINGS` with
   `INSERT OR IGNORE`.

To add a column: add it to the `CREATE TABLE` in `schema.ts` (for fresh DBs) **and** an `addColumn`
call in `migrate.ts` (for existing DBs). To add a table: add a new `CREATE TABLE IF NOT EXISTS` to
`schema.ts` — nothing else is needed.

## Tables

Symphony's schema has **12 tables** (count the `CREATE TABLE IF NOT EXISTS` statements in
`db/schema.ts`). Relationship overview:

```
projects ─┬─< issues ─┬─< issue_tasks
          │           ├─< runs ──< events (also issue-scoped)
          │           ├─< issue_revisions
          │           ├─1 issue_plan_context
          │           └── parent_id → issues (self-ref: sub-issues under an epic)
          ├─< issue_relations >─ issues   (source/target, typed edges)
          ├─< project_notes
          ├─< project_skills
          └─< ask_messages
settings  (global key/value; not project-scoped)
```

### 1. `projects`

One target repository + its agent policy. The top of the ownership tree.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `key` | TEXT UNIQUE | short uppercase code, e.g. `WEB`; issue keys derive from it |
| `name`, `description`, `color` | TEXT | display; `color` defaults `#6366F1` |
| `repo_path` | TEXT | local git repo; **required to run agents** (nullable so a project can exist without one) |
| `default_branch` | TEXT | default `main` |
| `context` | TEXT | optional extra context appended to every agent prompt |
| `model` | TEXT | optional per-project model override |
| `agent` | TEXT | optional per-project agent override (`claude`/`codex`); null ⇒ engine default |
| `preview_command` | TEXT | command to launch a preview from a worktree (`{port}` substituted) |
| `config` | TEXT (JSON) | per-project policy: `agent` / `prompts` / `verification` / `promotion` / `commit_guard` / `docs` (see [projectConfig](#project-config-json)) |
| `created_at` | TEXT | |

Mapped to `Project` (`src/shared/types.ts`). Repo: `repo/projects.ts`.

The `config` blob is parsed/serialized by `core/projectConfig.ts` (`parseProjectConfig` → `mergeProjectConfigs`), which copies **only** known sections — each new section needs its own merge/clone path or it is silently stripped on save. `docs.directories` (default `['docs']`, SYM-36) drives the Documentation tab's source folders; it is additive JSON, so no migration was needed and pre-existing projects get the default applied at parse time. The `agent` section also carries the optional SYM-41 execution controls `enable_workflow_tool` (boolean) and `thinking_effort` (`none`/`think`/`think-hard`/`ultrathink`) — copied field-by-field in `mergeAgent`; undefined ⇒ inherit the engine default.

### 2. `issues`

One unit of tracked work — the thing the user manages.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `project_id` | TEXT FK→projects | `ON DELETE CASCADE` |
| `parent_id` | TEXT FK→issues | self-ref; non-null ⇒ sub-issue under an "epic" (`ON DELETE SET NULL`) |
| `seq` | INTEGER | per-project running number; `key = "<KEY>-<seq>"` |
| `key` | TEXT | e.g. `WEB-12` (unique per project via `idx_issues_key`) |
| `type` | TEXT | `feature` \| `bug` \| `chore` \| `epic` (default `feature`) |
| `title`, `description`, `acceptance_criteria` | TEXT | |
| `labels` | TEXT (JSON array) | default `'[]'` |
| `priority` | INTEGER | `0`=none, `1`=urgent … `4`=low |
| `status` | TEXT | the lifecycle status (see [state machine](#status-state-machine)); default `backlog` |
| `mode` | TEXT | `auto` \| `manual` (default `manual`) — gates poll-loop pickup |
| `thinking_effort` | TEXT | per-issue extended-thinking override `none`/`think`/`think-hard`/`ultrathink` (SYM-46); NULL ⇒ inherit project ?? engine. Whitelist-guarded on read in `mapRow` |
| `require_review` | INTEGER (bool) | default `1`; off ⇒ a passing issue goes straight to `done` |
| `base_branch`, `branch_name`, `worktree_path` | TEXT | set when work starts |
| `round` | INTEGER | current revision round; `1`=first build, `2+`=after "request changes" |
| `merge_conflict` | TEXT (JSON) | `MergeConflictInfo` when a review-gate approval failed to merge/push (SYM-29); null otherwise |
| `created_at`, `updated_at` | TEXT | |

Indexes: `idx_issues_key` (unique `project_id,key`), `idx_issues_status`, `idx_issues_parent`.
Mapped to `Issue`. Repo: `repo/issues.ts`.

### 3. `issue_relations`

Typed directed edges between issues in a project (e.g. a follow-up chain).

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `project_id` | TEXT FK→projects | `ON DELETE CASCADE` |
| `source_issue_id`, `target_issue_id` | TEXT FK→issues | both `ON DELETE CASCADE`; `CHECK (source <> target)` |
| `type` | TEXT | `relates_to` (default) \| `follow_up` |
| `context_summary` | TEXT | predecessor-story context injected into later prompts |
| `created_at` | TEXT | |

Unique on `(source,target,type)`; indexed both directions. Mapped to `IssueRelation` /
`StoryReferenceContext`. Repo: `repo/issueRelations.ts`.

### 4. `issue_tasks`

The plan-phase checklist for an issue — one row per planned task.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `issue_id` | TEXT FK→issues | `ON DELETE CASCADE` |
| `seq` | INTEGER | order in the checklist |
| `role` | TEXT | `TaskRole`: `impl`\|`qa`\|`frontend`\|`backend`\|`docs`\|`delivery`\|`other` (default `impl`) |
| `title`, `intent` | TEXT | |
| `status` | TEXT | `TaskStatus`: `todo`\|`running`\|`done`\|`failed`\|`skipped` (default `todo`) |
| `created_at` | TEXT | |

Mapped to `IssueTask`. Repo: `repo/tasks.ts`. Note `delivery` is a *role*, executed inside the
implement phase — there is no separate delivery phase row in `runs` for it being a task (see
[AGENT_GUIDE.md](AGENT_GUIDE.md)).

### 5. `runs`

One persisted phase execution: a row per (issue, phase, attempt, round).

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `issue_id` | TEXT FK→issues | `ON DELETE CASCADE` |
| `attempt` | INTEGER | orchestrator retry counter (default 1) |
| `round` | INTEGER | revision round that produced this run; skip/resume queries are scoped to it |
| `phase` | TEXT | `RunPhase`: `plan`\|`implement`\|`qa`\|`delivery`\|`merge` |
| `status` | TEXT | `RunStatus`: `running`\|`succeeded`\|`failed`\|`timeout`\|`stalled`\|`cancelled` (default `running`) |
| `session_id` | TEXT | CLI session id (resumed on retries) |
| `error`, `report` | TEXT | failure reason / final agent text |
| `input_tokens`, `output_tokens`, `total_tokens`, `num_turns` | INTEGER | usage |
| `cache_read_tokens`, `cache_creation_tokens` | INTEGER | prompt-cache traffic — the bulk of real throughput |
| `started_at`, `ended_at` | TEXT | `ended_at` null while open |

Indexes: `idx_runs_issue`, `idx_runs_status`. Mapped to `Run`. Repo: `repo/runs.ts` (also powers the
Ops history view `OpsHistoryRow`). A run left `running` after a process crash is a *dangling run*,
closed out on restart (`recover`).

### 6. `issue_revisions`

The human "request changes" feedback that kicks off a new round (N ≥ 2). One row per round transition;
round 1 (the first build) never has a revision.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `issue_id` | TEXT FK→issues | `ON DELETE CASCADE` |
| `round` | INTEGER | the round this feedback kicks off (≥ 2) |
| `feedback` | TEXT | the reviewer's note, threaded into that round's prompts |
| `created_at` | TEXT | |

Indexed `(issue_id, round)`. Mapped to `IssueRevision`. Repo: `repo/revisions.ts`.

### 7. `issue_plan_context`

The compact exploration the plan phase saves so implement doesn't start cold. One row per issue (PK is
`issue_id`).

| Column | Type | Notes |
|--------|------|-------|
| `issue_id` | TEXT PK FK→issues | `ON DELETE CASCADE` |
| `notes` | TEXT | verification strategy / rollout / handoff expectations |
| `context` | TEXT | symbols, routes, data flow, commands, gotchas |
| `key_files` | TEXT (JSON array of `{path,purpose}`) | default `'[]'` |
| `created_at`, `updated_at` | TEXT | |

Mapped to `IssuePlanContext` / `PlanKeyFile`. Repo: `repo/planContext.ts`.

### 8. `events`

The activity feed behind the live SSE stream and the issue detail timeline.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `issue_id` | TEXT FK→issues | nullable; `ON DELETE CASCADE` |
| `run_id` | TEXT FK→runs | nullable; `ON DELETE CASCADE` |
| `kind` | TEXT | event type, e.g. `orchestrator.dispatch`, `phase.start`, `agent.tool`, `approve.merged` |
| `level` | TEXT | `debug`\|`info`\|`warn`\|`error` (default `info`) |
| `message` | TEXT | |
| `data` | TEXT (JSON) | optional structured payload |
| `created_at` | TEXT | |

Indexes: `idx_events_issue (issue_id,id)`, `idx_events_run (run_id,id)`. Mapped to `Event`. Repo:
`repo/events.ts` (exposes a monotonic `cursor` used by SSE `?since=`).

### 9. `project_notes`

Distilled learnings from completed issues, injected (newest-first) into future agent prompts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `project_id` | TEXT FK→projects | `ON DELETE CASCADE` |
| `issue_id` | TEXT FK→issues | nullable; `ON DELETE SET NULL` |
| `content` | TEXT | the learning |
| `created_at` | TEXT | |

Indexed `(project_id, created_at)`. Mapped to `ProjectNote`. Repo: `repo/notes.ts`.

### 10. `project_skills`

Reusable Claude Code skills attached to a project (SYM-14). Enabled rows are materialized into each
issue worktree's `.claude/skills/<slug>/SKILL.md` before the pipeline runs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `project_id` | TEXT FK→projects | `ON DELETE CASCADE` |
| `name`, `description` | TEXT | unique name per project (`idx_project_skills_name`) |
| `content` | TEXT | the SKILL.md body (front matter synthesized at materialize time) |
| `files` | TEXT (JSON array of `{path,content}`) | optional extra files; populated by GitHub folder/tree imports (SYM-50) and materialized alongside `SKILL.md`, relative paths preserved |
| `source` | TEXT | `manual` \| `github` \| `marketplace` |
| `source_url` | TEXT | origin for imported skills |
| `enabled` | INTEGER (bool) | default `1` |
| `created_at`, `updated_at` | TEXT | |

Mapped to `ProjectSkill` / `ProjectSkillFile`. Repo: `repo/projectSkills.ts`.

### 11. `settings`

Global engine configuration as key/value. Seeded from `DEFAULT_SETTINGS` (`core/config.ts`); edited on
the Settings page. Also holds migration marker rows.

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | e.g. `wip_limit`, `model`, or a `migration:*` marker |
| `value` | TEXT (JSON) | JSON-encoded value |
| `updated_at` | TEXT | |

Repo: `repo/settings.ts` (`getConfig()` merges these onto defaults via `resolveConfig`). Effective
keys + defaults:

| Key | Default | Numeric? |
|-----|---------|----------|
| `enabled` | `true` | — |
| `enable_workflow_tool` | `false` | — |
| `agent` | `claude` | — |
| `cli_path` | `claude` (`claude.cmd` on Windows) | — |
| `model` | `claude-sonnet-4-6` | — |
| `codex_cli_path` | `codex` (`codex.cmd` on Windows) | — |
| `codex_model` | `gpt-5-codex` | — |
| `permission_mode` | `bypassPermissions` | — |
| `wip_limit` | `3` | ✓ |
| `poll_interval_ms` | `30000` | ✓ |
| `workspace_root` | `<tmp>/symphony_workspaces` | — |
| `phase_timeout_ms` | `1200000` (20 min) | ✓ |
| `stall_timeout_ms` | `300000` (5 min) | ✓ |
| `max_turns` | `120` | ✓ |
| `thinking_effort` | `none` | — |
| `max_attempts` | `3` | ✓ |
| `max_retry_backoff_ms` | `300000` (5 min) | ✓ |

The "Numeric?" column maps to `NUMERIC_KEYS` (`core/config.ts`) — a new numeric setting needs both a
default and a `NUMERIC_KEYS` entry, or `resolveConfig` won't coerce it. Non-numeric keys need their own
`resolveConfig` branch: booleans (`enabled`, `enable_workflow_tool`) use a `Boolean()` case, and the
`thinking_effort` enum uses a value-whitelist branch placed BEFORE the loose string fallback (SYM-41).
`enable_workflow_tool` (default off) and `thinking_effort` (default `none`) are also per-project
overridable via the project `config.agent` blob. `thinking_effort` additionally has a per-issue layer
(SYM-46): `resolveThinkingEffort` (`phases/types.ts`) resolves it as **issue ?? project ?? engine**
from the nullable `issues.thinking_effort` column, so an explicit per-issue keyword (including `none`)
overrides both lower layers and NULL inherits them.

### 12. `ask_messages`

Persisted "ask" conversation, scoped to one project-day (SYM-12). A conversation is the set of turns
sharing a `convo_date` (server-local day); daily rollover is implicit in the `date('now','localtime')`
queries — there is no scheduler.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `project_id` | TEXT FK→projects | `ON DELETE CASCADE` |
| `convo_date` | TEXT | local calendar day, e.g. `2026-06-19` |
| `role` | TEXT | `user` \| `assistant` |
| `content` | TEXT | |
| `suggestion` | TEXT (JSON) | `AskSuggestion` draft issue on actionable assistant turns (SYM-28); null otherwise |
| `created_at` | TEXT | |

Indexed `(project_id, convo_date, id)`. Mapped to `AskMessage` / `AskHistory`. Repo: `repo/ask.ts`.

## Status state machine

`issues.status` (`IssueStatus` in `src/shared/types.ts`):

```
backlog ──▶ todo ──▶ in_progress ──▶ review ──┬─ approve ───────────▶ done
   ▲          ▲          │                     └─ request changes ──┐
   │          └──────────┘  (round + 1, back to todo) ◀─────────────┘
   └─ (manual moves)                in_progress / review / todo ──▶ cancelled (any time)
```

- **`backlog`** — not scheduled.
- **`todo`** — scheduled; eligible for the orchestrator when `mode=auto`.
- **`in_progress`** — an agent pipeline is running.
- **`review`** — agent work + self-QA + verification done; awaiting a human (the one gate).
- **`done`** — terminal; approved (and, on the autonomous path, pushed).
- **`cancelled`** — terminal; abandoned.

Two derived sets gate the orchestrator (`src/shared/types.ts`):

- `ACTIVE_STATUSES = ['todo','in_progress']` — the orchestrator acts on these.
- `TERMINAL_STATUSES = ['done','cancelled']` — never re-dispatched.

`review` is neither active nor terminal: it is the human gate. The review-gate transitions are owned
by the issue routes (`http/routes/issues.ts`): approve → merge/PR → `done`; request-changes → record
revision, `round + 1`, back to `todo`, re-dispatch.

## Mode

`issues.mode` (`IssueMode`): `auto` issues are picked up by the poll loop; `manual` issues only run on
an explicit "Run" (`POST /:id/run` → `runNow`). Failure give-up and verification-park both set
`mode='manual'` so a repeatedly-failing issue stops auto-retrying and waits for a human.

## Round (multi-round revisions)

`issues.round` starts at 1 (the first build). "Request changes" at the review gate records the
feedback in `issue_revisions`, increments `round`, and re-runs the pipeline **on the same
branch/worktree** building on prior commits. Run skip/resume queries are *round-scoped*
(`phases/index.ts:skipCompletedPhase`, `resumeSessionIdFor`), so round N re-runs plan→implement→qa
cold rather than reusing round N−1's successful runs. A stale `merge_conflict` decoration is cleared
when a new round starts.
