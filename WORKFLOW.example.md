---
# Optional per-repository policy contract (Symphony "policy lives in the repo" principle).
# Drop this file (renamed to WORKFLOW.md) into a target project's root to version its agent
# policy alongside the code. All fields are optional; anything omitted falls back to the
# engine defaults configured in the Symphony UI (Settings page).

agent:
  # Override the model for this repository's runs.
  model: claude-sonnet-4-6
  # CLI permission mode for headless runs in the isolated worktree.
  permission_mode: bypassPermissions
  # Cap turns per phase (bounds a single session's cost). Accepts a single number for all
  # phases, or a per-phase map — implement typically needs far more turns than plan/qa:
  #   max_turns:
  #     plan: 80
  #     implement: 160
  #     qa: 80
  max_turns: 120

# Phase-specific prompt additions appended to the built-in phase prompts. Use this to encode
# repo conventions the agent must follow (test commands, lint, commit style, etc.).
prompts:
  plan: |
    Prefer the smallest set of tasks. Call out any migration or breaking change explicitly.
  implement: |
    Use the repository's existing dependency tree if present. If packages are missing, run
    `npm install --prefer-offline` before falling back to a full install. Run `npm test` and
    `npm run lint` before considering the work done.
    If this repo needs a specific venv or tool path, record it here so every issue reuses it.
  qa: |
    Treat a failing build or test as an automatic FAIL.
---

# Workflow notes

The body of this file is free-form documentation for humans. The engine only reads the YAML
front matter above. See the project README for the full list of supported keys and precedence
rules (engine defaults → Settings → per-project overrides → this file).
