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
  events) and one module per phase. Each phase is ONE agent session. SYM-62: `index.ts`
  `persistAgentEvent` tags the durable `agent.tool` event with `data.skill` (the slug) whenever the
  agent calls the built-in `Skill` tool, and right before `finishRun` for a successful `delivery`
  phase it appends a deterministic `## Skills used` tail to the report via the pure
  `core/skillUsage.ts` (`extractSkillName` + `appendSkillsUsedSection`) fed by
  `repo/events.ts#listSkillsUsed(issueId, round)` — round-scoped over `agent.tool` events so it stays
  durable across retries (an in-memory set would miss skills from a skipped earlier attempt). Append
  only when ≥1 skill was used; no section otherwise.
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
  (issue ?? project ?? engine — SYM-46 added the per-issue layer; `Issue.thinking_effort`, a nullable
  `issues.thinking_effort` column, null ⇒ inherit) and only the pipeline passes it, so Ask is
  unaffected. `ThinkingEffort`'s canonical home is `src/shared/types.ts` (SYM-46); `core/config.ts`
  and the web `api.ts` re-export it.
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
- `src/server/repo/reviews.ts` + `http/routes/reviews.ts` (SYM-51) — the project "Review" tab: a
  standalone, READ-ONLY, agent-driven audit of a scope (`docs`/`code`/`ui_ux`/`all`), modeled on Ask
  (live repo, `permissionMode 'plan'`, `disableWorkflows`, NO worktree, NO `AbortSignal`), NOT the
  orchestrator pipeline. Unlike Ask it is **asynchronous**: `POST /api/projects/:id/reviews` validates
  scope + repo, enforces one-in-flight-per-project (`countRunningReviews`), inserts a `running`
  `review_runs` row, then `void executeReviewRun(...)` (fire-and-forget) and returns `202`.
  `executeReviewRun` is the awaitable, NEVER-throwing core (tests call it directly): runs the agent →
  `parseReview` → persists graded `review_findings` → flips the run `completed` (or `failed`). The
  agent emits a single `symphony-review` fence (`buildReviewPrompt`/`parseReview` in `core/prompt.ts`,
  next to the Ask fence; whitelist + bound + `MAX_REVIEW_FINDINGS` cap, malformed ⇒ `findings: []`,
  non-fatal). Findings surface as draft "issue cards": convert (severity→priority via `createIssue`,
  always `mode='manual'`, idempotent — re-convert is `409`) or dismiss (reversible). SYM-66 adds a
  one-click **batch convert** (`POST /:id/reviews/:runId/convert`, arity 4 so it never collides with
  the per-finding convert) that turns a run's remaining draft findings into `mode='auto'` issues
  (default; `status='todo'` ⇒ orchestrator-eligible via `listAutoCandidates`) and `void
  getOrchestrator().kick()`s so they dispatch promptly; `body.mode='manual'` / `status='backlog'` /
  `finding_ids` override the defaults. Structurally idempotent (only `draft` findings convert), so
  re-clicking mops up leftovers without duplicating issues. Two tables (`review_runs`,
  `review_findings`) via idempotent `schema.ts` — no `migrate.ts` ALTER. `index.ts` mounts
  `reviewRoutes` and calls `failInterruptedReviewRuns()` at boot so a restart never leaves a run stuck
  `running`. The route reads a `__setReviewBackgroundRunner` test seam (undefined in prod ⇒ real
  `runAgent`) so the offline 202 test never spawns a CLI.
- `src/server/workspace/` — per-issue git worktrees. Safety invariants: agent `cwd` must be the
  worktree, and the worktree must resolve inside `workspace_root`. `docs.ts` is a separate read-only
  reader (no worktree) that lists/reads the project repo's documentation for the Docs tab — every read
  is fenced inside the repo AND inside a configured doc directory (lexical + realpath checks).
- `src/server/http/middleware/auth.ts` (SYM-42; LAN-auth made fully optional in SYM-44) — the ONLY
  credential-checking surface: a pure factory `authMiddleware(token?)` (no-op when token unset; else
  Bearer / Basic(any-user:token) / `?token=` with `crypto.timingSafeEqual`, `GET /api/health` exempt,
  `401` + `WWW-Authenticate: Basic` otherwise) plus a pure `isLoopbackHost(host?)`. Kept FREE of
  `env.ts`/DB imports so the QA test builds it with a literal token. `index.ts` mounts it
  `app.use('*', authMiddleware(AUTH_TOKEN))` BEFORE `/api` + static so it gates API + prod SPA in one
  place, and passes `hostname: HOST` to `serve()`. Auth is **opt-in only** — SYM-44 removed the forced
  startup guard (and `SYMPHONY_ALLOW_INSECURE_LAN`): `HOST` still defaults to `localhost` (env.ts) so an
  install never self-exposes on upgrade, but a non-loopback bind without a token now just emits ONE
  non-blocking `log.warn` (informed consent — the bypassPermissions pipeline runs on the SERVER host,
  reachable unauthenticated) and starts. The token is **env-only by design** (`SYMPHONY_AUTH_TOKEN` in
  `env.ts`) — it must NOT enter the `settings` table / `core/config.ts`, or `GET /api/ops/settings` would
  leak it. Vite dev host is `SYMPHONY_WEB_HOST` (default localhost). LAN access, the optional token, the
  "where agents run" finding (CLI is spawned by the backend process, never the LAN client), and the
  security premise live in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
- `src/server/usage/localUsage.ts` + `http/routes/usage.ts` (SYM-38, SYM-39, SYM-40) — reader for the
  sidebar footer. SYM-39 repurposed it from spent token usage to **remaining** rate-limit quota. It
  streams the Claude (`<root>/projects/**/*.jsonl`, deduped by `message.id:requestId`) and Codex
  (`<root>/{sessions,archived_sessions}/**/rollout-*.jsonl`) session logs and returns a per-agent
  `LocalUsageReport`. For Codex it captures the LATEST `token_count.payload.rate_limits` snapshot (by
  timestamp, scanning files within an ~8-day mtime lookback so the weekly window stays visible) and
  builds `windows` with `remaining_percent = 100 − used_percent` (a window whose `resets_at`, epoch
  SECONDS in source, already passed rolls over to 100% remaining). Claude persists no quota locally, so
  SYM-40 (round 3: "show Claude's remaining like Codex") makes ONE best-effort outbound
  `GET <ANTHROPIC_BASE_URL>/api/oauth/usage` with the user's own local OAuth token (resolution order
  `CLAUDE_CODE_OAUTH_TOKEN` → `<root>/.credentials.json` → macOS keychain; skipped when no token /
  expired) and maps `five_hour`/`seven_day` → the SAME `RateWindow[]` (`five_hour`→primary 300min,
  `seven_day`→secondary 10080min; `utilization` = used %, ISO `resets_at` → epoch ms) so Claude renders
  like Codex. Both agents share `normalizeWindow` (clamp + roll-over). This is the ONE place the reader
  is no longer strictly no-network: the token goes only to the fixed Anthropic host over HTTPS (same
  trust boundary as Claude Code), is never logged nor returned to the client, and is never refreshed or
  written. Every fetch failure (no token / expired / offline / non-200 / parse) degrades to status
  `unsupported` — only genuine local FS errors become `error`. A ~30s module cache (test reset hook
  `__resetClaudeUsageCache`) coalesces the bursty sidebar polls. Today's token totals (Codex per-turn
  `last_token_usage`, NOT cumulative `total_token_usage`; filtered per-line to the server's LOCAL-machine
  day) are still computed for the tooltip on both agents. Each agent is read in its own try/catch so one
  missing/locked dir never blanks the other; `GET /api/usage/local` therefore always returns `200` with
  per-agent statuses (`ok`/`empty`/`unsupported`/`not_found`/`error`). Data roots honor `CLAUDE_CONFIG_DIR`
  (may be comma-separated) and `CODEX_HOME`, read at call time. **Test-offline safety:** `setupEnv()` sets
  `SYMPHONY_DISABLE_KEYCHAIN=1` and clears `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_BASE_URL`, so `npm test`
  never reads the dev's real keychain or hits the network — the one live-path test stubs `globalThis.fetch`
  + writes a fixture `.credentials.json`. It still WRITES nothing, so no new runtime path / `.gitignore`
  rule is needed.
- `src/web/` — React 19 + Vite + Tailwind v4 + TanStack Query. `src/shared/types.ts` holds domain
  types shared by both sides. The visual layer is a hand-rolled design system (SYM-59): semantic
  tokens + a global `@layer base` `:focus-visible` ring + native-`<dialog>` base in `globals.css`
  (new `@theme` tokens `--color-accent-hover` / `--color-ring` / `--color-success` / `--color-warning`
  / `--color-danger` / `--color-info`, plus themed `--elev-1/2/3` elevation vars — all existing token
  names preserved), and the shared primitives in `components/ui.tsx`: `cn()` (clsx + tailwind-merge),
  `Button` (size/loading), `Badge` (tones), `Panel` (interactive/elevated), `Field`/`Input`/`Textarea`/
  `Select` (focus ring + `aria-invalid`), `Spinner`, `PendingIndicator` + `useElapsedSeconds` (SYM-77:
  long async waits — spinner + label + a live elapsed counter; the elapsed span is `aria-hidden` inside
  the `role=status` region so it announces once, not per tick; the ticking text doubles as the
  reduced-motion activity signal — wired into Ask's "Thinking…" and Review's "Reviewing…"), plus
  `Modal` + `useModalDialog` (native `<dialog>`:
  focus-trap, Escape, scroll-lock, focus restore — `ApproveDialog`, the Board's New-issue form
  (SYM-65), the `AskPanel` drawer, the `PathField` picker, and IssueDetail's request-changes dialog
  all build on it), `PageHeader`,
  `ProjectChip`, `EmptyState`, `ErrorState`, `Skeleton`, and `Loading`. The shell (`Layout.tsx`) is
  responsive (off-canvas sidebar + mobile top bar under `lg`); `ProjectTabs` scroll on narrow. Full
  spec + load-bearing visual invariants (token names, `anim-page-in` `transform:none`, anti-FOUC) live
  in [`docs/DESIGN.md`](docs/DESIGN.md). Per-project tabs live in `components/ProjectTabs.tsx` (Board / Agent /
  Review / Story Tree / Docs / Skills) — the Story Tree tab (`pages/StoryTree.tsx`) folds a project's
  `issue_relations` into a forest via the pure `lib/storyTree.ts#buildStoryTrees` (follow_up edges
  nest, relates_to surface as cross-links), backed by read-only `GET /api/projects/:id/relations`.
  The Review tab (`pages/Review.tsx`, SYM-51) runs the standalone read-only project audit and lists
  each batch's graded findings as draft issue cards (grouped by severity), backed by
  `GET /api/projects/:id/reviews` (polled while a batch is `running`); `lib/format.ts` holds the
  `REVIEW_SEVERITY_META` / scope / category / status display metadata. SYM-66 adds a per-batch
  "Create all as auto issues (N)" bar (shown when a completed batch still has drafts) behind a
  confirm `Modal` — it calls `convertAllFindings` (auto + todo) and invalidates both the reviews
  list and the Board.
  The Docs tab (`pages/Documentation.tsx`, SYM-36) is a master/detail reader over the repo's docs,
  backed by read-only `GET /api/projects/:id/docs` + `/docs/content`; the source folders live in
  `config.docs.directories` (default `['docs']`) and are edited inline from the tab. The Skills tab
  (`pages/ProjectSkills.tsx`, SYM-14; redesigned SYM-63) browses a project's skills as a dense,
  responsive card grid (`grid-cols-1/md:2/xl:3`) with a search + source + status + sort toolbar
  (client-side `useMemo` filter/sort, live count, distinct empty vs no-match states) so a large set
  stays scannable; the GitHub-import / Claude-install / new-skill affordances are tucked behind one
  collapsed "Add skills" disclosure and create/edit run in the shared `Modal`. Source badge + filter
  share `lib/format.ts#SKILL_SOURCE_META` (mirrors `REVIEW_*_META`). Pure frontend — same
  `GET /api/projects/:id/skills` list endpoint, no contract change. The sidebar
  footer widget (`components/SidebarUsage.tsx`, SYM-38/SYM-39/SYM-40) shows local Claude/Codex
  **remaining** quota from `GET /api/usage/local`. BOTH agents render the same `ok` shape — the lowest
  remaining window ("NN% left", threshold-colored dot, 5h/Week reset tooltip): Codex from its local logs,
  Claude from the server's best-effort LIVE fetch (SYM-40 round 3), so a logged-in user sees real Claude
  remaining like Codex. When that live read can't run (not logged in / token expired / offline) the
  server returns `unsupported` and the Claude row honestly falls back to today's token usage ("N 今日",
  neutral dot) — or "无今日用量" when idle — plus an always-visible muted sub-line ("剩余量见 /usage")
  naming the command; the tooltip explains the fallback and points at `/login`. (Earlier rounds showed a
  flat "本地不可用" that misread as "Claude unavailable".) Refreshes every 60s and whenever the shared
  `['issues']` poll's status/`updated_at` signature changes.

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
  save. `thinking_effort` is ALSO per-issue overridable (SYM-46): the nullable `issues.thinking_effort`
  column (whitelist-guarded in `repo/issues.ts#mapRow`, null ⇒ inherit) is the highest-priority layer
  in `resolveThinkingEffort` (issue ?? project ?? engine). Attachment limits live here too:
  `max_attachment_bytes` (default 10 MB) and
  `max_attachments_per_item` (default 10), both numeric and UI-editable via the `settings` table.
- Privacy boundary: only framework code is tracked. Runtime/private data — `data/` (the SQLite DB +
  attachment blobs), per-issue worktrees under `workspace_root`, `.env`, and machine-local agent/editor
  config (`.claude/settings.local.json`, live `WORKFLOW.md`) — is gitignored and must never be
  committed. Conversation transcripts live in `~/.claude`, not the repo. When adding a feature that
  writes new runtime/private paths, add a matching rule to the repo's own `.gitignore` (grouped,
  commented) in the same change — don't rely on a machine-global ignore.
