# CLAUDE.md

Symphony — orchestrates Claude Code CLI agents against a built-in issue tracker. An orchestrator
picks up issues, runs a `plan → implement → qa` agent pipeline per issue in an isolated git
worktree, and parks the result at a human review gate.

Deep reference lives in [`docs/`](docs/): [PRD](docs/PRD.md),
[ARCHITECTURE](docs/ARCHITECTURE.md) (module map, lifecycle, orchestrator loop, glossary),
[DATA_MODEL](docs/DATA_MODEL.md) (tables + state machine), [API](docs/API.md), and
[AGENT_GUIDE](docs/AGENT_GUIDE.md) (phases, load-bearing role titles, prompt assembly, how to
extend). Update the matching doc when you change behavior.

## Commands

```bash
npm run dev          # Hono server (:3030) + Vite client (:5173)
npm test             # offline e2e tests (node:test, fake agent runner, no tokens)
npm run lint         # type-check client (tsconfig.json) + server (tsconfig.server.json)
npm run seed         # demo project + issues
```

Node 22.5+ (uses built-in `node:sqlite`). No compile step — server runs via `tsx`.

## Architecture map

- `src/server/orchestrator/` — the ONLY authority over scheduling. `state.ts` is the single
  in-memory runtime state; `orchestrator.ts` owns dispatch / retry / give-up; `worker.ts` bridges
  to the pipeline. Nothing else mutates `RuntimeState`.
- `src/server/phases/` — execution layer for one issue: `index.ts` (sequencer, persists run rows +
  events) and one module per phase. Each phase is ONE agent session.
- `src/server/agent/` — the DI seam. `types.ts` defines `AgentRunner`; `claudeRunner.ts` spawns
  `claude --print --output-format stream-json`. Orchestrator/phases never import the CLI directly;
  tests inject a fake runner instead. `AgentRunInput.disableWorkflows` (SYM-41, required) gates
  Claude Code's built-in Workflow multi-agent tool: both runners spawn with the pure exported
  `claudeRunner.ts#runnerEnv(process.env, disableWorkflows)`, which injects
  `CLAUDE_CODE_DISABLE_WORKFLOWS=1` when true so a pipeline agent can't self-spawn background runs
  (the orchestrator stays the sole scheduler). The var is claude-only — Codex ignores it; the
  injection is mirrored for runner symmetry. Default-off ⇒ `disableWorkflows` defaults to `true`.
- `src/server/core/prompt.ts` — all agent prompt assembly (issue brief, per-phase prompts, retry
  failure context, project learnings, fence parsing). Each phase prompt holds its role (tech lead /
  implementing engineer / QA engineer / release engineer) to a shared professional-team quality floor
  — non-functional + UX design, a mandatory doc-update step, per-criterion QA — that `WORKFLOW.md` /
  per-project `prompts.*` only append to. The role-title substrings are load-bearing: `fakeRunner.ts`
  detects the phase by them, so keep them verbatim. `TaskRole` (`src/shared/types.ts`) includes
  `delivery`, a plan-emitted handoff task executed inside the implement phase (no separate phase).
  Attachments (SYM-35) are rendered as an `## Attachments` section appended to `issueBrief()` /
  `buildAskPrompt()` AFTER the other sections, so the load-bearing role substrings never shift.
  `thinking_effort` (SYM-41) likewise appends a `## Thinking effort\n<keyword>` block in
  `issueBrief()`'s tail (only when not `none`); `phases/types.ts#resolveThinkingEffort` resolves it
  (project ?? engine) and only the pipeline passes it, so Ask is unaffected.
- `src/server/repo/` — one file per table, all SQL lives here. `db/schema.ts` is idempotent
  (`CREATE TABLE IF NOT EXISTS`, runs every boot); additive `ALTER TABLE` backfills go in
  `db/migrate.ts`. There is no migration tool.
- `src/server/repo/attachments.ts` + `http/routes/attachments.ts` (SYM-35) — file attachments for
  issues / ask turns. Blobs live on disk under `ATTACHMENTS_DIR` (`env.ts`, = `DATA_DIR/attachments`,
  durable — NOT the ephemeral workspace root) at `<id>/<sanitized-filename>`; the DB row holds the
  metadata + relative `storage_path`. Endpoints: `POST /api/attachments` (multipart upload, returns
  an id), `GET /api/attachments/:id` (serve bytes; `?download=1` for a download disposition),
  `DELETE /api/attachments/:id`. Issue create/update and ask POST carry `attachment_ids` (small JSON)
  which the server links. Two safety invariants mirror the worktree §9.5 rule: filenames are
  sanitized to one safe segment on write, and every read asserts the path stays inside
  `ATTACHMENTS_DIR`. Agents read the absolute paths in place (pipeline = bypassPermissions, ask =
  plan mode), so nothing is copied into the worktree.
- `src/server/workspace/` — per-issue git worktrees. Safety invariants: agent `cwd` must be the
  worktree, and the worktree must resolve inside `workspace_root`. `docs.ts` is a separate read-only
  reader (no worktree) that lists/reads the project repo's documentation for the Docs tab — every read
  is fenced inside the repo AND inside a configured doc directory (lexical + realpath checks).
- `src/server/usage/localUsage.ts` + `http/routes/usage.ts` (SYM-38, SYM-39) — read-only reader for the
  sidebar footer. SYM-39 repurposed it from spent token usage to **remaining** rate-limit quota. It
  streams the Claude (`<root>/projects/**/*.jsonl`, deduped by `message.id:requestId`) and Codex
  (`<root>/{sessions,archived_sessions}/**/rollout-*.jsonl`) session logs and returns a per-agent
  `LocalUsageReport`. For Codex it captures the LATEST `token_count.payload.rate_limits` snapshot (by
  timestamp, scanning files within an ~8-day mtime lookback so the weekly window stays visible) and
  builds `windows` with `remaining_percent = 100 − used_percent` (a window whose `resets_at`, epoch
  SECONDS in source, already passed rolls over to 100% remaining). Claude exposes NO local quota state,
  so it returns status `unsupported`. Today's token totals (Codex per-turn `last_token_usage`, NOT
  cumulative `total_token_usage`; filtered per-line to the server's LOCAL-machine day) are still computed
  for the tooltip on both agents. Each agent is read in its own try/catch so one missing/locked dir never
  blanks the other; `GET /api/usage/local` therefore always returns `200` with per-agent statuses
  (`ok`/`empty`/`unsupported`/`not_found`/`error`). Data roots honor `CLAUDE_CONFIG_DIR` (may be
  comma-separated) and `CODEX_HOME`, read at call time (tests + the hermetic `setupEnv()` override them).
  It only READS the CLIs' own dirs and writes nothing, so no new runtime path and no `.gitignore` rule
  are needed.
- `src/web/` — React 19 + Vite + Tailwind v4 + TanStack Query. `src/shared/types.ts` holds domain
  types shared by both sides. Per-project tabs live in `components/ProjectTabs.tsx` (Board / Agent /
  Story Tree / Docs / Skills) — the Story Tree tab (`pages/StoryTree.tsx`) folds a project's
  `issue_relations` into a forest via the pure `lib/storyTree.ts#buildStoryTrees` (follow_up edges
  nest, relates_to surface as cross-links), backed by read-only `GET /api/projects/:id/relations`.
  The Docs tab (`pages/Documentation.tsx`, SYM-36) is a master/detail reader over the repo's docs,
  backed by read-only `GET /api/projects/:id/docs` + `/docs/content`; the source folders live in
  `config.docs.directories` (default `['docs']`) and are edited inline from the tab. The sidebar
  footer widget (`components/SidebarUsage.tsx`, SYM-38/SYM-39) shows local Claude/Codex **remaining**
  quota from `GET /api/usage/local` — Codex's lowest remaining window ("NN% left", threshold-colored
  dot) and Claude's honest `unsupported` row — refreshing every 60s and whenever the shared `['issues']`
  poll's status/`updated_at` signature changes.

## Conventions

- Tests use `node:test` + `tsx --test` (no test framework dep). Each test file calls
  `tests/helpers/env.ts#setupEnv()` BEFORE importing server modules (they read env at import), and
  drives the real pipeline with `tests/helpers/fakeRunner.ts`. Keep new tests offline — the real
  CLI path is exercised manually, never in `npm test`.
- Repo modules return mapped domain types from `src/shared/types.ts`; raw row interfaces stay
  private to the repo file.
- Comments explain invariants and "why", referencing the Symphony spec section (e.g. §7.4) where
  relevant — match that style, not line-by-line narration.
- Config precedence: defaults (`core/config.ts`) → `settings` table → per-project `model` →
  per-repo `WORKFLOW.md`. New settings need a default + (if numeric) an entry in `NUMERIC_KEYS`.
  Non-numeric keys need an explicit branch in `resolveConfig` — booleans (`enabled`,
  `enable_workflow_tool`) get a `Boolean()` case, enums (`thinking_effort`) a value-whitelist branch
  BEFORE the loose string fallback (which would otherwise accept any non-empty string). The SYM-41
  agent-execution controls `enable_workflow_tool` (boolean, default `false`) and `thinking_effort`
  (`none`/`think`/`think-hard`/`ultrathink`, default `none`) are also per-project overridable via
  `config.agent` — copy each field-by-field in `projectConfig.ts#mergeAgent` or it is stripped on
  save. Attachment limits live here too: `max_attachment_bytes` (default 10 MB) and
  `max_attachments_per_item` (default 10), both numeric and UI-editable via the `settings` table.
- Privacy boundary: only framework code is tracked. Runtime/private data — `data/` (the SQLite DB +
  attachment blobs), per-issue worktrees under `workspace_root`, `.env`, and machine-local agent/editor
  config (`.claude/settings.local.json`, live `WORKFLOW.md`) — is gitignored and must never be
  committed. Conversation transcripts live in `~/.claude`, not the repo. When adding a feature that
  writes new runtime/private paths, add a matching rule to the repo's own `.gitignore` (grouped,
  commented) in the same change — don't rely on a machine-global ignore.
