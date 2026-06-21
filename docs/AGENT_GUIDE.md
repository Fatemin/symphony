# Symphony — Agent & Contributor Guide

The operational contract for the part of Symphony that drives coding agents. Read this before
changing phases, prompts, roles, per-repo policy, or the verification/promotion/commit-guard paths.
It complements [ARCHITECTURE.md](ARCHITECTURE.md) (how the system is wired) and
[DATA_MODEL.md](DATA_MODEL.md) (what persists).

## 1. Phases & the pipeline

One issue runs through a fixed sequence of **phases**, each of which is exactly **one agent session**.
`PHASE_ORDER` (`src/server/phases/types.ts:118`) is:

```
plan → implement → qa → delivery
```

A fifth phase, **`merge`**, exists in the `RunPhase` union (`src/shared/types.ts`) but is **not** in
`PHASE_ORDER`. It runs only on the *autonomous* path — when `require_review` is off and promotion is
`direct-merge` — to push the branch and integrate it on the remote (`phases/index.ts:runIssuePipeline`,
the `finalStatus === 'done'` block). On the review path the human approve route owns promotion, so
running `merge` there would double-merge.

| Phase | Role title (in the prompt) | Builder | What it does | Output it must emit |
|-------|----------------------------|---------|--------------|---------------------|
| `plan` | **tech lead** | `buildPlanPrompt` | Read the repo, produce a task checklist + planning context. No code. | a `symphony-plan` JSON fence |
| `implement` | **implementing engineer** | `buildImplementPrompt` | Implement end-to-end in the worktree; update docs; run checks. | a free-text report |
| `qa` | independent **QA engineer** | `buildQaPrompt` | Re-verify each acceptance criterion + build/test/lint + docs. | a `QA_RESULT: PASS\|FAIL — …` last line |
| `delivery` | **delivery lead** | `buildDeliveryPrompt` | Read-only; write a friendly user-facing summary of the round. | Markdown (the whole reply is the deliverable) |
| `merge` | **release engineer** | `buildMergePrompt` | Push the branch + integrate on the remote (autonomous path only). | a `MERGE_RESULT: PASS\|FAIL — …` last line |

`delivery` is **best-effort**: a failed delivery summary is logged and skipped, never blocking the
review gate (`phases/index.ts`, the `phase === 'delivery'` guard). All prompt assembly lives in
[`src/server/core/prompt.ts`](../src/server/core/prompt.ts).

> **Skills-used tail (SYM-62).** After a *successful* delivery, the sequencer appends a deterministic
> `## Skills used` section to the report, listing every Claude Code skill the issue invoked **this
> round** (across plan/implement/qa/delivery). The list comes from the round's persisted `agent.tool`
> events (`data.skill`, written by `persistAgentEvent` for every `Skill` tool call), de-duplicated and
> sorted by `repo/events.ts#listSkillsUsed` and formatted by the pure `core/skillUsage.ts`. It is
> appended by `phases/index.ts` (not the agent and not `delivery.ts`) so it stays out of the agent's
> free-text report and captures every phase's skill use. No skills used → no section.

> **Phase vs. task role.** `delivery` is *also* a `TaskRole` (`src/shared/types.ts:TaskRole`) the plan
> can emit, executed *inside* the implement phase as a handoff/summary task — distinct from the
> `delivery` *phase* that runs after QA. Both exist; don't conflate them.

## 2. Load-bearing role titles (the fakeRunner contract)

The role-title substrings in the phase prompts are **load-bearing** and must stay **verbatim**.
`tests/helpers/fakeRunner.ts:phaseOf` detects the phase purely by matching these substrings in the
prompt text:

```ts
// tests/helpers/fakeRunner.ts
if (prompt.includes('independent **QA engineer**')) return 'qa';
if (prompt.includes('**delivery lead**'))           return 'delivery';
if (prompt.includes('**release engineer**'))        return 'merge';
if (prompt.includes('**implementing engineer**'))   return 'implement';
return 'plan';
```

If you reword a role title in `core/prompt.ts`, the fake runner will mis-detect the phase and the
offline test suite will return the wrong canned output — silently breaking `npm test`. The exact
strings to preserve (each appears in `core/prompt.ts`):

| Phase | Substring that must appear verbatim |
|-------|-------------------------------------|
| plan | `**tech lead**` (note: detected by *elimination* — it's the fallback) |
| implement | `**implementing engineer**` |
| qa | `independent **QA engineer**` |
| delivery | `**delivery lead**` |
| merge | `**release engineer**` |

Order matters too: `phaseOf` checks QA before implement, so keep the substrings mutually
unambiguous. There is no separate "which phase" flag passed to the runner — the prompt *is* the
signal.

## 3. Prompt assembly: append, never replace

Every phase prompt is built from a shared **issue brief** (`prompt.ts:issueBrief`) plus the phase's
role-specific body. The brief already carries: the issue + acceptance criteria, the current round's
revision feedback (round ≥ 2, surfaced *above* project context), project context, predecessor-story
context, recent project learnings, available project skills, the worktree/branch reminder, the
"unattended — never use interactive tools" instruction, (on retries) the prior-failure context, and
(SYM-41, pipeline only) a trailing `## Thinking effort\n<keyword>` block when `thinking_effort` ≠
`none` — appended in the brief's tail *before* the role body, so `includes()`-based phase detection
is position-insensitive and the role substrings never shift. `resolveThinkingEffort` picks the
keyword **issue ?? project ?? engine** (SYM-46 added the per-issue layer via `Issue.thinking_effort`).

Each role body enforces a **professional-team quality floor** that per-repo policy can only *append*
to:

- **plan** — design for architecture/contracts, non-functional, UX (all states), documentation, and
  verification; add a `delivery` task when a handoff is warranted.
- **implement** — smallest correct change; match the existing style/design system; polished
  accessible UX; **update every affected doc** (a missing doc update is incomplete work); add/update
  tests; run checks; don't commit (the orchestrator commits).
- **qa** — build/test/lint failures are an automatic FAIL; check each acceptance criterion explicitly;
  watch regressions + non-functional bar; **stale docs for a behavior change are a FAIL**.
- **delivery** — read-only, friendly summary (What's new / How to use it / Files changed / Docs
  updated). The sequencer then appends a deterministic `## Skills used` tail (SYM-62) when the issue
  invoked any Claude Code skill this round — see the Skills-used note in §1.
- **merge** — push + integrate only; never rewrite code.

Per-repo and per-project prompt additions are **appended** under a `## Repository policy` heading
(`prompt.ts:withPolicy`) — they sharpen the baseline with repo conventions; they never weaken it. This
is the central design principle: *quality is the prompt floor, and policy can only add to it.*

> **Runner env (SYM-41, not a prompt change).** The Workflow-tool toggle is enforced at the process
> level, never in the prompt: `agentInput` computes `disableWorkflows = !enable_workflow_tool`, and
> both runners spawn with `claudeRunner.ts#runnerEnv(process.env, disableWorkflows)`, which injects
> `CLAUDE_CODE_DISABLE_WORKFLOWS=1` when disabled. Default-off keeps the orchestrator the sole
> scheduler. Putting the toggle in env (not the prompt) is deliberate — the role substrings and the
> fakeRunner contract stay untouched. The var is claude-only (Codex ignores it; mirrored for runner
> symmetry). That the env var actually removes the tool is verified by a real-CLI smoke check (it
> costs tokens — `npm test` can't prove it); the offline tests assert the field/env plumbing only.

### Fences the pipeline parses

| Fence / marker | Emitted by | Parsed by | Shape |
|----------------|-----------|-----------|-------|
| ```` ```symphony-plan ```` | plan | `parsePlan` | `{ tasks:[{role,title,intent}], key_files:[{path,purpose}], context, notes }` |
| `QA_RESULT: PASS\|FAIL — reason` | qa | `parseQa` | last-match-wins (so quoted policy can't shadow the verdict); absent ⇒ FAIL |
| `MERGE_RESULT: PASS\|FAIL — reason` | merge | `parseMerge` | last-match-wins; absent ⇒ FAIL |
| ```` ```symphony-ask ```` | ask | `parseAsk` | `{ convertible, type, title, description, acceptance_criteria }` |
| ```` ```symphony-review ```` | review | `parseReview` | `{ summary, findings:[{category,type,severity,title,description,acceptance_criteria}] }` |

Parsing is deliberately tolerant (loose/missing fences fall back), but the emitting prompt text and
the parser must change together.

`symphony-ask` and `symphony-review` are **not** pipeline phases — both are standalone, read-only
agent operations (`http/routes/ask.ts`, `http/routes/reviews.ts`) that run against the live repo in
`plan` mode, not the orchestrator. `buildReviewPrompt(project, scope)` (`core/prompt.ts`) is
scope-aware (`docs` / `code` / `ui_ux` / `all`); `parseReview` whitelists every enum, drops a finding
with no title, bounds string lengths, and caps the list (`MAX_REVIEW_FINDINGS`). A missing/malformed
fence is non-fatal — the run still completes with `findings: []`. Each finding is surfaced as a draft
issue card the user converts (severity→priority) or dismisses.

## 4. Task roles

The plan emits tasks carrying a `TaskRole` (`src/shared/types.ts`):
`impl | qa | frontend | backend | docs | delivery | other`. `prompt.ts:normalizeRole` clamps anything
unknown to `impl`. Tasks are persisted in `issue_tasks` (see [DATA_MODEL.md](DATA_MODEL.md)) and
rendered into the implement prompt as a checklist. `delivery`-role tasks are the in-implement handoff
(distinct from the delivery phase — see §1).

## 5. Per-repo policy: `WORKFLOW.md` and project config

A target repo can version its own agent policy in **`WORKFLOW.md`** (YAML front matter), loaded fresh
per run by `core/workflow.ts:loadWorkflow` (no file-watching). The same policy shape can also live in
the project row's `config` JSON. Both are merged into the effective `ProjectConfig`
(`core/projectConfig.ts:mergeProjectConfigs`). The canonical, commented template is
[`WORKFLOW.example.md`](../WORKFLOW.example.md) — **reference it; don't duplicate the YAML contract
here.**

What it can set (`WorkflowPolicy` / `ProjectConfig`):

- `agent.model`, `agent.permission_mode`, `agent.max_turns` (a single number **or** a per-phase
  `{plan, implement, qa, delivery, merge}` map), `agent.type` (`claude`/`codex`).
- `agent.enable_workflow_tool` (boolean) and `agent.thinking_effort` (`none`/`think`/`think-hard`/
  `ultrathink`) — the SYM-41 agent-execution controls. **Project config only** (engine default +
  project layers; `WorkflowPolicy` has no field for them, so WORKFLOW.md can't set them yet).
  `thinking_effort` additionally has a per-issue layer (SYM-46, `Issue.thinking_effort`), resolved
  as issue ?? project ?? engine — set it from the new-issue form or the issue detail header.
- `prompts.{plan,implement,qa,delivery,merge}` — appended to that phase's baseline (§3).
- `verification.commands` — objective gate (see §7).
- `promotion` — `direct-merge` (default) or `pull-request`, plus `remote`, `base_branch`,
  `auto_merge`, `push`.
- `commit_guard` — see §7.

**Precedence for agent-run fields** (`phases/types.ts:agentInput`):
`WORKFLOW.md → per-project (project.model / project.config) → engine config`. The agent CLI is resolved
first because it selects the binary + default model. Invalid `max_turns` values are dropped *with a
warning* rather than silently ignored.

## 6. Engine configuration

Engine defaults are `core/config.ts:DEFAULT_SETTINGS`; the `settings` table overrides them; per-project
`model`/`config` and `WORKFLOW.md` layer on top. Full default table is in
[DATA_MODEL.md](DATA_MODEL.md) §settings and the root [README.md](../README.md). **Adding a setting:**
add a default in `DEFAULT_SETTINGS`, and — if it's numeric — an entry in `NUMERIC_KEYS`, or
`resolveConfig` won't coerce string-from-DB values back to numbers.

## 7. The execution rails

Beyond the prompts, the pipeline enforces objective rails (all in `src/server/`):

- **Worktree isolation** (`workspace/worktree.ts:ensureWorktree`). Every issue runs in its own git
  worktree under `workspace_root`. Two safety invariants are enforced: the agent's `cwd` **must** be
  the worktree, and the worktree **must** resolve inside `workspace_root`. Agents never touch the main
  checkout.
- **Verification** (`workspace/verification.ts`, configured via `verification.commands`). Commands run
  in order inside the worktree after the phases; every command must exit 0 **and** leave the tree
  clean before the issue can reach `review`/`done`. This objective result — not the self-QA verdict —
  is the gate. `on_failure: retry|park` decides what happens on failure.
- **Promotion** (`workspace/promotion.ts` + the approve route). `direct-merge` merges locally and
  (per `promotion.push`) fast-forwards the remote base; `pull-request` rebases, re-verifies, pushes,
  and opens/merges a PR with `gh`. A failed integration leaves a `merge_conflict` decoration and a
  Resolve-conflict path (SYM-29).
- **Commit guard** (`commit_guard`, hook installed by `workspace/worktree.ts:installCommitGuardHook`).
  Optional pre-commit hook that blocks manual commits, rejects configured scratch globs, and enforces
  `max_files`/`max_bytes`. Off by default.
- **The orchestrator never lets a phase leak.** The pipeline catches phase throws into
  `PhaseOutcome{ok:false}`, and a runner resolves `ok:false` rather than throwing — so retry policy is
  centralized (see [ARCHITECTURE.md](ARCHITECTURE.md) §4).

**Agents do not commit their own work** — the orchestrator commits after the implement phase. The
implement prompt says so explicitly; preserve that contract when editing it.

## 8. Testing contract

Tests use `node:test` via `tsx --test` (no test framework dependency). Each test file calls
`tests/helpers/env.ts:setupEnv()` **before** importing any server module (modules read env at import
time), then drives the *real* pipeline + orchestrator against a throwaway git repo + isolated SQLite
DB, with the CLI replaced by `tests/helpers/fakeRunner.ts`. Keep new tests **offline** — the real CLI
path is exercised manually, never in `npm test`.

`makeFakeRunner` options let a test force a QA/merge FAIL, fail a phase once (transient), or return a
quota error once — covering the orchestrator's retry/park/suspend paths. Because detection is by role
title (§2), any prompt change that renames a role must be paired with a fakeRunner update.

Run the gates (all offline, zero token cost):

```bash
npm run lint   # tsc: client (tsconfig.json) then server (tsconfig.server.json)
npm test       # offline node:test pipeline + orchestrator via the fake runner
npm run build  # Vite client build (server has no build step — it runs via tsx)
```

## 9. How to extend

Recipes that respect the seams:

- **Add a phase.** Add the value to `RunPhase` (`src/shared/types.ts`), a builder in `core/prompt.ts`
  with a **distinct, verbatim role title**, a `phases/<phase>.ts` module, a branch in
  `phases/index.ts:runIssuePipeline`, and — if it should sequence automatically — an entry in
  `PHASE_ORDER` (`phases/types.ts`). Then add a detection branch in `fakeRunner.ts:phaseOf` and update
  this doc's §1/§2 tables.
- **Change a role's quality floor.** Edit the role body in `core/prompt.ts`. Keep the role-title
  substring verbatim (§2). If the change adds a parsed marker/fence, update the matching parser and
  §3.
- **Add a per-repo policy field.** Extend `WorkflowPolicy`/`ProjectConfig` + the merge functions
  (`core/workflow.ts`, `core/projectConfig.ts`), wire it where it's consumed, document it in
  [`WORKFLOW.example.md`](../WORKFLOW.example.md), and reference it from §5 here.
- **Add an engine setting.** §6.
- **Add a table/column.** See the migration convention in [DATA_MODEL.md](DATA_MODEL.md) — `schema.ts`
  for fresh DBs *and* `migrate.ts` `addColumn` for existing ones.
- **Swap the agent CLI / add a new one.** Implement the `AgentRunner` contract (`agent/types.ts`) and
  register it in `agent/runAgent.ts:makeAgentRunner`. The orchestrator/phases are unaffected — they
  hold one `AgentRunner` and branch on `input.agent`.
- **Swap the issue source.** Implement `Tracker` (`tracker/localTracker.ts`); the orchestrator never
  knows it isn't SQLite.

When you change behavior, update the affected doc in this set in the same change — the cardinal rule
from [docs/README.md](README.md). Stale docs for a behavior change are treated as incomplete work (and
QA is prompted to fail on exactly that).
