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
  preview_command: string | null; // command to launch a preview from a worktree ({port} substituted)
  config: unknown | null; // optional per-project JSON policy (verification/promotion/commit guard)
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
  /** Current revision round: 1 = first build, 2+ = re-run after a human requested changes at review. */
  round: number;
  created_at: string;
  updated_at: string;
}

/** A human "request changes" note at the review gate that starts a new revision round. */
export interface IssueRevision {
  id: string;
  issue_id: string;
  round: number; // the round this feedback kicks off (>= 2)
  feedback: string;
  created_at: string;
}

export type IssueRelationType = 'follow_up' | 'relates_to';

export interface IssueLink {
  id: string;
  project_id: string;
  key: string;
  type: IssueType;
  title: string;
  status: IssueStatus;
  priority: Priority;
  created_at: string;
  updated_at: string;
}

export interface IssueRelation {
  id: string;
  project_id: string;
  source_issue_id: string;
  target_issue_id: string;
  type: IssueRelationType;
  context_summary: string | null;
  created_at: string;
  source: IssueLink;
  target: IssueLink;
}

export interface IssueRelationMap {
  incoming: IssueRelation[];
  outgoing: IssueRelation[];
}

export interface StoryReferenceContext {
  relation_id: string;
  source_issue_id: string;
  source_key: string;
  source_title: string;
  relation_type: IssueRelationType;
  context_summary: string;
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

export interface PlanKeyFile {
  path: string;
  purpose: string;
}

export interface IssuePlanContext {
  issue_id: string;
  notes: string | null;
  context: string | null;
  key_files: PlanKeyFile[];
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  issue_id: string;
  attempt: number;
  /** Revision round that produced this run — skip/resume queries are scoped to it. */
  round: number;
  phase: RunPhase;
  status: RunStatus;
  session_id: string | null;
  error: string | null;
  report: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  num_turns: number;
  /** Prompt-cache traffic — the bulk of real token throughput; without it runs look misleadingly cheap. */
  cache_read_tokens: number;
  cache_creation_tokens: number;
  started_at: string;
  ended_at: string | null;
}

/** A distilled learning from a completed issue, injected into later agent prompts. */
export interface ProjectNote {
  id: string;
  project_id: string;
  issue_id: string | null;
  content: string;
  created_at: string;
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
  /**
   * Set while the whole queue is paused (e.g. an agent quota limit); `null` when running
   * normally. New dispatches are blocked until `until`, but a manual Run overrides it per-issue.
   */
  suspended: { until: number; reason: string | null } | null;
}

/**
 * One row per issue that has been run at least once — the persisted history behind the Ops
 * page (the live Snapshot only holds in-flight work). Token/turn totals are summed across all
 * of the issue's runs; `last_status`/`last_phase` describe its most recent run.
 */
export interface OpsHistoryRow {
  issue_id: string;
  issue_key: string;
  title: string;
  type: IssueType;
  status: IssueStatus; // current issue status
  project_id: string;
  project_key: string;
  run_count: number;
  attempts: number; // highest attempt number reached
  total_tokens: number; // SUM across runs
  num_turns: number; // SUM across runs
  started_at: string | null; // MIN(run.started_at), ISO
  ended_at: string | null; // MAX(run.ended_at), ISO — null while a run is still open
  updated_at: string; // issue.updated_at, ISO
  last_status: RunStatus | null; // most recent run's status
  last_phase: RunPhase | null; // most recent run's phase
}
