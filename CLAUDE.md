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
  tests inject a fake runner instead.
- `src/server/core/prompt.ts` — all agent prompt assembly (issue brief, per-phase prompts, retry
  failure context, project learnings, fence parsing). Each phase prompt holds its role (tech lead /
  implementing engineer / QA engineer / release engineer) to a shared professional-team quality floor
  — non-functional + UX design, a mandatory doc-update step, per-criterion QA — that `WORKFLOW.md` /
  per-project `prompts.*` only append to. The role-title substrings are load-bearing: `fakeRunner.ts`
  detects the phase by them, so keep them verbatim. `TaskRole` (`src/shared/types.ts`) includes
  `delivery`, a plan-emitted handoff task executed inside the implement phase (no separate phase).
- `src/server/repo/` — one file per table, all SQL lives here. `db/schema.ts` is idempotent
  (`CREATE TABLE IF NOT EXISTS`, runs every boot); additive `ALTER TABLE` backfills go in
  `db/migrate.ts`. There is no migration tool.
- `src/server/workspace/` — per-issue git worktrees. Safety invariants: agent `cwd` must be the
  worktree, and the worktree must resolve inside `workspace_root`. `docs.ts` is a separate read-only
  reader (no worktree) that lists/reads the project repo's documentation for the Docs tab — every read
  is fenced inside the repo AND inside a configured doc directory (lexical + realpath checks).
- `src/web/` — React 19 + Vite + Tailwind v4 + TanStack Query. `src/shared/types.ts` holds domain
  types shared by both sides. Per-project tabs live in `components/ProjectTabs.tsx` (Board / Agent /
  Story Tree / Docs / Skills) — the Story Tree tab (`pages/StoryTree.tsx`) folds a project's
  `issue_relations` into a forest via the pure `lib/storyTree.ts#buildStoryTrees` (follow_up edges
  nest, relates_to surface as cross-links), backed by read-only `GET /api/projects/:id/relations`.
  The Docs tab (`pages/Documentation.tsx`, SYM-36) is a master/detail reader over the repo's docs,
  backed by read-only `GET /api/projects/:id/docs` + `/docs/content`; the source folders live in
  `config.docs.directories` (default `['docs']`) and are edited inline from the tab.

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
