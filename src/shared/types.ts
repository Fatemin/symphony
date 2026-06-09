// Domain types shared between the server and the web client.
// These mirror the SQLite schema (see src/server/db/schema.ts) plus a few view models.

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled';

/** Statuses the orchestrator will actively pick up / act on. */
export const ACTIVE_STATUSES: IssueStatus[] = ['todo', 'in_progress'];
/** Terminal statuses — never re-dispatched. */
export const TERMINAL_STATUSES: IssueStatus[] = ['done', 'cancelled'];

export type IssueType = 'feature' | 'bug' | 'chore' | 'epic';
export type IssueMode = 'auto' | 'manual';
export type Priority = 0 | 1 | 2 | 3 | 4; // 0 = none, 1 = urgent … 4 = low

export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'skipped';
export type TaskRole = 'impl' | 'qa' | 'frontend' | 'backend' | 'docs' | 'other';

export type RunPhase = 'plan' | 'implement' | 'qa';
export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'stalled'
  | 'cancelled';

export interface Project {
  id: string;
  key: string; // short uppercase code, e.g. "WEB"
  name: string;
  description: string | null;
  color: string;
  repo_path: string | null; // local git repo; required to run agents
  default_branch: string;
  context: string | null; // optional extra context appended to agent prompts
  model: string | null; // optional per-project model override
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  parent_id: string | null; // self-ref; non-null ⇒ sub-issue grouped under an "epic" issue
  key: string; // e.g. "WEB-12"
  type: IssueType;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  labels: string[];
  priority: Priority;
  status: IssueStatus;
  mode: IssueMode;
  require_review: boolean;
  base_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueTask {
  id: string;
  issue_id: string;
  seq: number;
  role: TaskRole;
  title: string;
  intent: string | null;
  status: TaskStatus;
  created_at: string;
}

export interface Run {
  id: string;
  issue_id: string;
  attempt: number;
  phase: RunPhase;
  status: RunStatus;
  session_id: string | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  num_turns: number;
  started_at: string;
  ended_at: string | null;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Event {
  id: string;
  issue_id: string | null;
  run_id: string | null;
  kind: string;
  level: EventLevel;
  message: string;
  data: unknown | null;
  created_at: string;
}

// ── Orchestrator observability view models ────────────────────────────────

export interface RunningRow {
  issue_id: string;
  issue_key: string;
  title: string;
  phase: RunPhase;
  attempt: number;
  started_at: number; // epoch ms
  last_event_at: number | null;
  num_turns: number;
  total_tokens: number;
}

export interface RetryingRow {
  issue_id: string;
  issue_key: string;
  attempt: number;
  due_at: number; // epoch ms
  error: string | null;
}

export interface Snapshot {
  running: RunningRow[];
  retrying: RetryingRow[];
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  poll_interval_ms: number;
  wip_limit: number;
  enabled: boolean;
}
