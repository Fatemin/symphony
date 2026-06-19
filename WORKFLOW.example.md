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
  # phases, or a per-phase map — implement typically needs far more turns than plan/qa/merge:
  #   max_turns:
  #     plan: 80
  #     implement: 160
  #     qa: 80
  #     merge: 40
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
  merge: |
    Runs only on the autonomous done path (require_review: false and promotion.mode: direct-merge).
    A release agent pushes the issue branch to `promotion.remote` and integrates it into the base
    branch on the remote. Add repo-specific push/merge rules here, e.g. require a fast-forward only
    or open a PR with `gh` instead of pushing the base branch directly.

# Objective verification gate. Commands run in order inside the issue worktree; every command must
# exit 0 and leave the worktree clean before the issue can reach review/done.
verification:
  commands:
    - command: npm test
      cwd: .
      timeout_ms: 120000
      on_failure: retry

# Promotion remains direct-merge by default. Use pull-request when the repository has a GitHub
# remote and branch protection/required CI should be the merge authority.
promotion:
  mode: direct-merge
  remote: origin
  # base_branch: testing
  auto_merge: false

# Disabled by default for backwards compatibility. When enabled, the worktree hook blocks manual
# commits and Symphony refuses configured scratch files / oversized commits.
commit_guard:
  enabled: false
  blocked_untracked_globs:
    - "*_TEMP.*"
    - "scratch*.md"
---

# Workflow notes

The body of this file is free-form documentation for humans. The engine only reads the YAML
front matter above. See the project README for the full list of supported keys and precedence
rules (engine defaults → Settings → per-project overrides → this file).
