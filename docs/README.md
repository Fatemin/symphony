# Symphony documentation

This directory is the **deep reference layer** for Symphony — the orchestrator that runs Claude Code
CLI agents against a built-in issue tracker. The repository root keeps the quick-start material; these
docs go a level deeper and are grounded in the actual source (each claim cites a `path:symbol`).

> **Where to start:** the root [`README.md`](../README.md) is the user-facing "how it works" guide
> (status model, quick start, scripts, configuration). [`CLAUDE.md`](../CLAUDE.md) is the terse
> developer architecture map. These `docs/*` files are what they link *into* when you need the full
> picture.

## Contents

| Doc | What it covers | Read it when you… |
|-----|----------------|-------------------|
| [PRD.md](PRD.md) | Product vision, problem, target user, the "manage work, not agents" model, scope, status model, success criteria | want the **why** behind the system |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layered module map, the issue lifecycle data flow, the orchestrator tick loop + runtime state, key design rationale, glossary | need to understand **how it fits together** before changing it |
| [DATA_MODEL.md](DATA_MODEL.md) | Every table in `db/schema.ts` (fields, relations, purpose), the additive-migration convention, the status / mode / round state machine | touch the **schema, repos, or persisted state** |
| [API.md](API.md) | The HTTP + SSE endpoint reference (`/api/*`), grounded in `http/routes/*` and the Hono entry | call or change the **server API** |
| [AGENT_GUIDE.md](AGENT_GUIDE.md) | The operational contract for agents/contributors: phases & load-bearing role titles, prompt assembly, `WORKFLOW.md`/config, task roles, worktree/verification/promotion/commit-guard, the fakeRunner detection contract, and how-to-extend recipes | extend the **pipeline, prompts, phases, or config** |
| [DEPLOYMENT.md](DEPLOYMENT.md) | LAN access via `HOST`, the optional `SYMPHONY_AUTH_TOKEN` shared-token gate, where agents actually run (the backend host, not the LAN client), and the `bypassPermissions` exposure premise | expose the server **beyond localhost** on a LAN, or harden access |
| [DESIGN.md](DESIGN.md) | The web UI design system: token system, shared primitives (`ui.tsx`), the canonical loading/empty/error/disabled/focus states, accessibility + responsive rules, and the load-bearing visual invariants | build or restyle the **frontend / UI components** |

## Who reads what

- **Product / new contributors** → [PRD.md](PRD.md), then the root [README.md](../README.md).
- **Backend engineers** → [ARCHITECTURE.md](ARCHITECTURE.md) + [DATA_MODEL.md](DATA_MODEL.md).
- **API / frontend consumers** → [API.md](API.md).
- **Frontend / UI engineers** → [DESIGN.md](DESIGN.md) + [ARCHITECTURE.md §8](ARCHITECTURE.md#8-frontend-overview).
- **Anyone changing how agents run** (phases, prompts, policy) → [AGENT_GUIDE.md](AGENT_GUIDE.md).
- **Operators / anyone exposing the server on a LAN** → [DEPLOYMENT.md](DEPLOYMENT.md).

## Keeping these docs honest

These docs are the project's maintenance reference. The cardinal rule (it is also baked into every
phase prompt — see [AGENT_GUIDE.md](AGENT_GUIDE.md)): **a behavior change that leaves a doc stale is
incomplete work, not a follow-up.** When you change schema, routes, config defaults, phase roles, or
the lifecycle, update the matching doc in the same change. Every factual claim here should be
traceable to a cited source file; if you find drift, fix the doc and the citation together.
