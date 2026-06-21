# Symphony — Product Requirements (PRD)

> Status: living document. Describes what Symphony is and the problem it solves, so feature work can
> be judged against intent rather than re-derived. Mechanics live in [ARCHITECTURE.md](ARCHITECTURE.md);
> this is the **why**.

## 1. Vision

Symphony is a local, single-user system that lets one person run a small team of coding agents the
way an engineering manager runs a team of people: you describe **work** as tracked issues, and a
long-running orchestrator picks them up, drives a coding agent through a plan → implement → QA
pipeline in an isolated git worktree, and parks the finished result at a single human-review gate.

It is a ground-up reimplementation of OpenAI's
[Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/) orchestration concept,
with two substitutions:

- **Claude Code CLI** in place of Codex as the agent runtime (the agent CLI is pluggable — a Codex
  runner also ships; see [AGENT_GUIDE.md](AGENT_GUIDE.md)).
- A **built-in, Linear-style issue tracker** in place of Linear.

## 2. The core model: manage work, not agents

The defining product decision is the level of abstraction the user operates at.

- **You manage work.** You create, prioritize, and review issues on a board. You decide what gets
  built and whether the result is good enough to land.
- **The system manages agents.** Scheduling, concurrency limits, retries, backoff, stall detection,
  worktree isolation, and restart recovery are all the orchestrator's job, not yours. You never
  babysit a terminal or shepherd a single agent session.

The only place a human is *required* in the loop is the **review gate** (see §6). Everything between
"issue is ready" and "work is awaiting review" is autonomous.

## 3. Problem & motivation

Driving coding agents by hand does not scale past one task at a time and is easy to get wrong:

- **No isolation.** Running an agent directly in your checkout risks half-finished edits, dirty trees,
  and cross-task interference.
- **No supervision.** A single agent session has no retry policy, no stall detection, and no bounded
  concurrency — if it wedges, it wedges silently.
- **Inconsistent quality.** Ad-hoc prompting produces a change that compiles but skips the
  non-functional bar: tests, docs, accessibility, regressions.
- **Lost context.** Each run starts cold; nothing carries planning context, prior failures, or
  per-project conventions forward.

Symphony's predecessor was a prototype (`agile-with-agent`) that proved the concept but accreted god
files and an untestable execution path. Symphony is the cleanly-layered rebuild: no god files, the
agent runner behind a dependency-injection seam, and the whole pipeline testable offline (no tokens,
no live CLI). See [ARCHITECTURE.md](ARCHITECTURE.md) §"Design rationale".

## 4. Target user

A **single developer** running Symphony locally against their own machine and their own git repos:

- Comfortable with the Claude Code CLI and git worktrees.
- Wants to parallelize routine-to-moderate engineering work across several issues while staying the
  reviewer of record.
- Owns the target repositories — agents run with real filesystem and git access inside isolated
  worktrees, not a sandbox (see §7, Safety).

Explicit non-audience (today): teams, multi-tenant/hosted use, and untrusted-repo execution.

## 5. Goals & non-goals

### Goals

1. **Autonomy with a single human gate.** From `todo` to `review` requires no human interaction;
   approval is the one required human decision.
2. **Isolation by default.** Every issue runs in its own git worktree; agents never touch the main
   checkout.
3. **A professional-team quality floor.** Every phase prompt holds its role (tech lead / engineer /
   QA / delivery / release) to one shared bar — non-functional + UX design, a mandatory doc-update
   step, and per-criterion QA — that per-repo policy can only *append* to, never weaken
   (see [AGENT_GUIDE.md](AGENT_GUIDE.md)).
4. **Resilience.** Bounded concurrency (WIP limit), exponential-backoff retries, give-up-to-manual
   after N attempts, stall detection, agent-quota suspension, and restart recovery — all owned by one
   authoritative scheduler.
5. **Carry context forward.** Planning context, prior-failure context, distilled project learnings,
   and predecessor-story context are threaded into prompts so runs don't start cold.
6. **Testable offline.** The full pipeline + orchestrator run deterministically against a fake agent
   runner with no tokens spent — `npm test` is CI-safe.
7. **Policy lives in the repo.** A target repo can version its own agent policy in `WORKFLOW.md`.

### Non-goals

- **Not a sandbox.** Symphony does not contain or sandbox the agent; isolation is a git worktree on a
  real checkout, and headless runs default to `bypassPermissions`. Human control is at the review
  gate, not per command.
- **Not multi-user.** No auth, no multi-tenancy, no collaboration features.
- **Not a migration-managed datastore.** The schema is hand-rolled and idempotent; there is no
  migration tool or down-migrations (see [DATA_MODEL.md](DATA_MODEL.md)).
- **Not a general CI system.** Verification commands run inside the worktree as a gate, but Symphony
  is not a build farm.

## 6. Feature scope

### Shipped

- **Projects & issues.** Linear-style board with projects, issues (feature/bug/chore/epic),
  sub-issues, priorities, labels, and inter-issue relations (`relates_to`, `follow_up`).
- **Agent pipeline.** `plan → implement → qa → delivery` per issue, one agent session per phase, in an
  isolated worktree. A separate `merge` phase publishes the branch on the autonomous (gate-disabled)
  path. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Orchestrator.** Auto-dispatch of `mode=auto` issues, manual "Run" override, WIP-bounded
  concurrency, retry/backoff, give-up, stall detection, quota suspension, restart recovery.
- **Review gate.** Approve (merge/PR), request changes (starts a new revision *round* on the same
  branch), and a git-conflict resolution path when an approval can't be integrated.
- **Multi-round revisions.** "Request changes" feedback bumps the issue's round and re-runs the
  pipeline on the same worktree, building on prior commits.
- **Promotion.** Direct local merge (+ optional push) or pull-request mode (rebase, verify, push,
  open/merge a PR with `gh`).
- **Verification gate.** Per-project `verification.commands` must pass and leave a clean worktree
  before an issue can reach `review`/`done`.
- **Commit guard.** Optional pre-commit hook in each worktree that blocks manual commits, scratch
  files, and oversized commits.
- **Project skills.** Reusable Claude Code skills attached to a project, materialized into each
  worktree's `.claude/skills/`.
- **Ask.** Conversational, read-only Q&A about a project's repo that can distill an answer into a
  draft issue.
- **Observability.** Live activity stream (SSE) per issue, an Ops page with a runtime snapshot + token
  totals + run history.
- **Command palette.** A keyboard-first global navigation layer (⌘K / Ctrl+K) that fuzzy-searches every
  project, project section, issue, and quick action (new issue, toggle theme, kick orchestrator) from
  any page; a `?` overlay documents the keyboard contract. See [DESIGN.md §9](DESIGN.md).

### Out of scope (today)

Authentication, multi-tenancy, hosted deployment, automatic worktree garbage collection, and a
`WORKFLOW.md` file-watcher (it is read fresh per run). See the root README's "Known limitations".

## 7. Safety posture

Headless runs default to `bypassPermissions`: there is no human at the CLI to answer per-command
prompts, so agents act freely **inside their isolated worktree** — a real checkout on your machine,
not a sandbox. Two invariants are enforced by the workspace layer: the agent's working directory must
be the issue's worktree, and that worktree must resolve inside the configured `workspace_root`. Human
control lives at the review gate, not per command. Operators who want a tighter rail can switch
`permission_mode` to `acceptEdits`.

## 8. Success criteria

Symphony is succeeding when:

- A user can create issues, set them to `auto`, and walk away — the orchestrator drives them to
  `review` without intervention, respecting the WIP limit.
- A failed phase retries with backoff and, if it keeps failing, parks to `manual` instead of looping
  forever; a quota limit pauses the whole queue rather than burning attempts.
- Approving a reviewed issue lands the work (merge or PR) and the issue reaches `done`; requesting
  changes produces a tighter next round on the same branch.
- The change that lands meets the quality floor: acceptance criteria checked per-criterion, tests/
  lint/build green where they exist, and docs updated to match new behavior.
- `npm test` exercises the full pipeline + orchestrator offline, deterministically, at zero token
  cost — so the scheduling and lifecycle logic stays trustworthy as the system grows.

## 9. Glossary

A short orientation; the authoritative glossary with source citations is in
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Issue** — one unit of tracked work; the thing the user manages.
- **Phase** — one agent session in the pipeline (`plan`, `implement`, `qa`, `delivery`, `merge`).
- **Round** — a revision cycle; round 1 is the first build, round N≥2 is a re-run after "request
  changes".
- **Review gate** — the single point where a human approves or requests changes.
- **Worktree** — the isolated git checkout one issue's agents run inside.
- **Orchestrator** — the single authority over scheduling and every issue state transition.
