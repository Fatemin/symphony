// Single source of truth for the database schema.
// All statements are idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
// so they can run on every boot. There is no migration tool: additive schema changes are
// applied as new IF NOT EXISTS statements, and one-off backfills live in migrate.ts.

export const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  key            TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  color          TEXT NOT NULL DEFAULT '#6366F1',
  repo_path       TEXT,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  context         TEXT,
  model           TEXT,
  agent           TEXT,
  preview_command TEXT,
  config          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id           TEXT REFERENCES issues(id) ON DELETE SET NULL,
  seq                 INTEGER NOT NULL,            -- per-project running number → key = "<KEY>-<seq>"
  key                 TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'feature',
  title               TEXT NOT NULL,
  description         TEXT,
  acceptance_criteria TEXT,
  labels              TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  priority            INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'backlog',
  mode                TEXT NOT NULL DEFAULT 'manual',
  require_review      INTEGER NOT NULL DEFAULT 1,
  base_branch         TEXT,
  branch_name         TEXT,
  worktree_path       TEXT,
  round               INTEGER NOT NULL DEFAULT 1,  -- current revision round (1 = first build, 2+ = re-review changes)
  merge_conflict      TEXT,                        -- JSON MergeConflictInfo when a review-gate approval failed to merge/push (SYM-29)
  thinking_effort     TEXT,                        -- per-issue extended-thinking override; NULL = inherit project/engine (SYM-46)
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_key ON issues(project_id, key);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);

CREATE TABLE IF NOT EXISTS issue_relations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type            TEXT NOT NULL DEFAULT 'relates_to',
  context_summary TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (source_issue_id <> target_issue_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_relations_unique
  ON issue_relations(source_issue_id, target_issue_id, type);
CREATE INDEX IF NOT EXISTS idx_issue_relations_source ON issue_relations(source_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_relations_target ON issue_relations(target_issue_id);

CREATE TABLE IF NOT EXISTS issue_tasks (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL DEFAULT 'impl',
  title      TEXT NOT NULL,
  intent     TEXT,
  status     TEXT NOT NULL DEFAULT 'todo',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_issue ON issue_tasks(issue_id);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL DEFAULT 1,
  round         INTEGER NOT NULL DEFAULT 1,  -- which revision round produced this run (skip/resume are scoped to it)
  phase         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  session_id    TEXT,
  error         TEXT,
  report        TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  num_turns     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- Per-round revision feedback: the user's "request changes" note that kicks off round N (N >= 2).
-- One row per round transition; round 1 (the first build) never has a revision.
CREATE TABLE IF NOT EXISTS issue_revisions (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  feedback   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_revisions_issue ON issue_revisions(issue_id, round);

CREATE TABLE IF NOT EXISTS issue_plan_context (
  issue_id    TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  notes       TEXT,
  context     TEXT,
  key_files   TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT REFERENCES issues(id) ON DELETE CASCADE,
  run_id     TEXT REFERENCES runs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  data       TEXT,                                  -- JSON blob
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id, id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);

CREATE TABLE IF NOT EXISTS project_notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id   TEXT REFERENCES issues(id) ON DELETE SET NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_project ON project_notes(project_id, created_at);

-- Reusable Claude Code skills attached to a project (SYM-14). Enabled rows are materialized into
-- each issue worktree's .claude/skills/<slug>/SKILL.md before the agent pipeline runs, so agents
-- can reference them; the YAML front matter (name + description) is synthesized at materialize time.
CREATE TABLE IF NOT EXISTS project_skills (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  content     TEXT NOT NULL DEFAULT '',             -- the SKILL.md body (front matter excluded)
  files       TEXT,                                  -- optional JSON array of {path, content} extras
  source      TEXT NOT NULL DEFAULT 'manual',        -- 'manual' | 'github'
  source_url  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_skills_name ON project_skills(project_id, name);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Persisted "ask" conversation, scoped to one project-day (SYM-12). A conversation is the set of
-- turns sharing a convo_date (server-local day); the panel reloads today's turns on open and the
-- user can manually reset (delete) today's. Daily rollover is implicit in the date('now','localtime')
-- queries — there is no scheduler.
CREATE TABLE IF NOT EXISTS ask_messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  convo_date TEXT NOT NULL,                         -- local calendar day, e.g. '2026-06-19'
  role       TEXT NOT NULL,                         -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  suggestion TEXT,                                  -- JSON AskSuggestion on actionable assistant turns (SYM-28); NULL otherwise
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ask_messages_project_date ON ask_messages(project_id, convo_date, id);

-- User-supplied file attachments for an issue or an ask turn (SYM-35). Blobs live on disk under
-- ATTACHMENTS_DIR (DATA_DIR/attachments); this table is the metadata + the relative storage_path.
-- A row may be linked to an issue (issue_id) or an ask message (ask_message_id), or neither yet
-- (uploaded but not yet attached — the form was abandoned). project_id is required so the
-- ON DELETE CASCADE reclaims orphans when a project is deleted. New additive table — no migrate.ts.
CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id        TEXT REFERENCES issues(id) ON DELETE CASCADE,
  ask_message_id  TEXT REFERENCES ask_messages(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,                       -- original display name (sanitized on disk)
  mime            TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  storage_path    TEXT NOT NULL,                       -- relative to ATTACHMENTS_DIR: '<id>/<safe-name>'
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_issue ON attachments(issue_id);
CREATE INDEX IF NOT EXISTS idx_attachments_ask ON attachments(ask_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments(project_id);

-- Project review (SYM-51). A review is a standalone, READ-ONLY agent run (modeled on Ask, NOT the
-- orchestrator pipeline) that inspects a scope (docs / code / ui_ux / all) and emits graded findings.
-- One review_runs row per batch; review_findings rows are the draft "issue cards" within it. Two
-- new additive tables — no migrate.ts ALTER needed. project ON DELETE CASCADE reclaims everything;
-- a finding's issue_id is SET NULL if the converted issue is later deleted (the card just loses its key).
CREATE TABLE IF NOT EXISTS review_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,                         -- 'docs' | 'code' | 'ui_ux' | 'all'
  status        TEXT NOT NULL DEFAULT 'running',       -- 'running' | 'completed' | 'failed'
  agent         TEXT,                                  -- concrete agent that ran the review
  summary       TEXT,                                  -- the agent's overview; NULL until completed
  error         TEXT,                                  -- failure reason when status = 'failed'
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_runs_project ON review_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_runs_status ON review_runs(status);

CREATE TABLE IF NOT EXISTS review_findings (
  id                  TEXT PRIMARY KEY,
  review_run_id       TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,                -- per-run running number for stable ordering
  category            TEXT NOT NULL DEFAULT 'code',    -- 'docs' | 'code' | 'ui_ux'
  type                TEXT NOT NULL DEFAULT 'feature', -- 'feature' | 'bug' (what a converted issue becomes)
  title               TEXT NOT NULL,
  description         TEXT,
  acceptance_criteria TEXT,
  severity            TEXT NOT NULL DEFAULT 'medium',  -- 'critical' | 'high' | 'medium' | 'low'
  status              TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'converted' | 'dismissed'
  issue_id            TEXT REFERENCES issues(id) ON DELETE SET NULL,  -- set on convert
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_review_findings_run ON review_findings(review_run_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_project ON review_findings(project_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_status ON review_findings(status);
`;
