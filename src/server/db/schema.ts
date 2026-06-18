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

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;
