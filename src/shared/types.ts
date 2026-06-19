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
/** Which CLI agent drives a project's pipeline. */
export type AgentType = 'claude' | 'codex';
export type Priority = 0 | 1 | 2 | 3 | 4; // 0 = none, 1 = urgent … 4 = low

export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'skipped';
// `delivery` is a plan-emitted role executed inside the implement phase (there is no separate
// delivery phase) — it asks the engineer for a handoff/summary of what shipped (SYM-24).
export type TaskRole = 'impl' | 'qa' | 'frontend' | 'backend' | 'docs' | 'delivery' | 'other';

/**
 * Decoration on an issue parked at the review gate whose approval could not be integrated (SYM-29).
 * `kind` distinguishes a local merge conflict (agent branch vs. its base) from a push divergence
 * (the remote base moved). Surfaced as a red "git conflict" badge on the board and a banner +
 * Resolve-conflict action on the detail page; the resolve-conflict endpoint re-runs the merge and an
 * agent-backed remote reconcile, clearing this once the work lands. It is also cleared when a new
 * revision round starts (the marker is stale once the branch is rebuilt).
 */
export interface MergeConflictInfo {
  kind: 'merge' | 'push';
  target_branch: string;
  remote?: string;
  reason: string;
  files?: string[];
  detected_at: string; // ISO
}

export type RunPhase = 'plan' | 'implement' | 'qa' | 'delivery' | 'merge';
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
  agent: AgentType | null; // optional per-project agent override (null ⇒ inherit engine default)
  preview_command: string | null; // command to launch a preview from a worktree ({port} substituted)
  config: unknown | null; // optional per-project JSON policy (verification/promotion/commit guard)
  created_at: string;
}

/**
 * A user-supplied file attached to an issue or an ask turn (SYM-35). The blob lives on disk under
 * ATTACHMENTS_DIR; this view model carries only display metadata — the byte stream is served from
 * `GET /api/attachments/:id`, and the on-disk storage_path is never exposed to the client.
 */
export interface Attachment {
  id: string;
  project_id: string;
  issue_id: string | null;
  ask_message_id: string | null;
  filename: string;
  mime: string;
  size_bytes: number;
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
  /** Set when a review-gate approval failed to merge/push; null otherwise (SYM-29). */
  merge_conflict: MergeConflictInfo | null;
  /** Files attached to this issue (SYM-35); only populated on the issue-detail read. */
  attachments?: Attachment[];
  created_at: string;
  updated_at: string;
}

/**
 * Board view model (SYM-32): an Issue plus the phase of its most-recent run, surfaced on the
 * board card so an in-progress issue shows whether it's in plan / implement / qa / etc. The field
 * is derived (read from `runs` on each request), not a DB column, and is only populated while the
 * issue is `in_progress` — `null` for every other status.
 */
export interface BoardIssue extends Issue {
  current_phase: RunPhase | null;
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

export type ProjectSkillSource = 'manual' | 'github' | 'marketplace';

/** An optional extra file shipped alongside a multi-file skill (relative to the skill directory). */
export interface ProjectSkillFile {
  path: string;
  content: string;
}

/**
 * A reusable Claude Code skill attached to a project (SYM-14). Enabled skills are materialized into
 * every issue worktree's `.claude/skills/<slug>/SKILL.md` before the agent pipeline runs, so agents
 * can reference them. `content` holds the SKILL.md body only — the YAML front matter (name +
 * description) is synthesized from this row at materialize time.
 */
export interface ProjectSkill {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  content: string;
  files: ProjectSkillFile[];
  source: ProjectSkillSource;
  source_url: string | null; // origin for github-imported skills
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Result of installing a Claude Code marketplace plugin's skills (SYM-17). A single paste can pull
 * several skills; duplicates (by name) are reported in `skipped` rather than failing the batch.
 */
export interface MarketplaceInstallResult {
  imported: ProjectSkill[];
  skipped: { name: string; reason: string }[];
}

// ── Documentation tab (SYM-36) ────────────────────────────────────────────

/** One documentation file discovered under a project's configured doc directories. */
export interface DocEntry {
  /** Repo-relative POSIX path, e.g. "docs/PRD.md". */
  path: string;
  /** Basename, e.g. "PRD.md". */
  name: string;
  /** The configured top-level directory it was found under (e.g. "docs") — used to group the list. */
  dir: string;
}

/** The Documentation tab listing: the configured directories plus the files found within them. */
export interface DocListing {
  directories: string[];
  files: DocEntry[];
}

/** A single documentation file's contents, for the reading pane. */
export interface DocContent {
  path: string;
  name: string;
  content: string;
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

// ── Ask: conversational project Q&A ───────────────────────────────────────

/** One turn in an "ask" conversation about a project. */
export interface AskMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * The draft issue distilled from this turn, persisted so the suggestion card survives a
   * conversation switch (panel reopen / project switch), not just the live session (SYM-28).
   * Only ever set on assistant turns; null/absent when the answer was purely informational.
   */
  suggestion?: AskSuggestion | null;
  /** Files the user attached to this turn (SYM-35); only ever set on user turns. */
  attachments?: Attachment[];
}

/**
 * A draft issue distilled from an answer — surfaced when the exchange describes concrete work,
 * so the user can one-click convert it into a feature/bug.
 */
export interface AskSuggestion {
  type: Extract<IssueType, 'feature' | 'bug'>;
  title: string;
  description: string;
  acceptance_criteria: string;
}

export interface AskResponse {
  /** The conversational answer (the suggestion fence is stripped out). */
  answer: string;
  /** CLI session id of the run (informational; ask is otherwise stateless). */
  session_id: string | null;
  /** Present only when the answer is actionable as a feature/bug. */
  suggestion: AskSuggestion | null;
}

/** Today's persisted conversation for a project, used to reseed the Ask panel on open (SYM-12). */
export interface AskHistory {
  /** The server-local day these turns belong to, e.g. '2026-06-19'. */
  date: string;
  messages: AskMessage[];
}

// ── Local CLI usage / remaining quota (SYM-38, SYM-39) ─────────────────────

/**
 * Per-agent detection result for the sidebar "Remaining" widget. SYM-39 repurposed this widget from
 * token *usage* to remaining rate-limit quota, since the user wants to see what's left, not what's
 * spent. Codex logs its live rate limits locally; Claude does not (its logs carry no quota state).
 * - `ok`          — Codex: a rate-limit snapshot was found, so `windows` carry remaining quota.
 * - `empty`       — Codex: the data dir was found but no recent rate-limit snapshot exists.
 * - `unsupported` — Claude: the data dir was found, but remaining quota is NOT derivable locally.
 *                   Claude persists no quota state to its logs/caches; `/usage` fetches what's left
 *                   LIVE from Anthropic (keychain OAuth token + an authenticated endpoint), so it
 *                   can't be read here without breaking the read-only-local/no-network contract.
 *                   `usage` holds today's totals, which the row headlines ("N 今日") as an honest
 *                   fallback so the agent never reads as unavailable (SYM-40); an always-visible
 *                   "剩余量见 /usage" hint + the tooltip carry the remaining-not-local caveat.
 * - `not_found`   — the data dir does not exist (the CLI isn't installed, or has never run).
 * - `error`       — an unexpected failure reading the dir (e.g. EACCES); `error` carries the reason.
 */
export type UsageStatus = 'ok' | 'empty' | 'unsupported' | 'not_found' | 'error';

/** Token totals summed across one agent's local sessions for the current local-machine day. */
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  /** Prompt-cache reads (the bulk of Claude throughput); 0 for agents that don't report it. */
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** input + output + cache_read + cache_creation — today's total, shown in the tooltip. */
  total_tokens: number;
}

/**
 * One remaining-quota window for an agent (Codex exposes two: a short rolling window + a weekly one).
 * `remaining_percent = clamp(0, 100, 100 - used_percent)`. A window whose `resets_at` has already
 * passed has rolled over since the snapshot, so it is reported as fully remaining (used 0 / left 100)
 * with `resets_at` projected forward to the next boundary.
 */
export interface RateWindow {
  /** Which slot in the source rate-limit object: the short rolling window vs. the weekly one. */
  key: 'primary' | 'secondary';
  /** 0..100 — how much of this window's quota is consumed. */
  used_percent: number;
  /** 0..100 — `100 - used_percent`, the figure the footer headlines. */
  remaining_percent: number;
  /** Window length in minutes (e.g. 300 = 5h, 10080 = weekly); 0 if unknown. */
  window_minutes: number;
  /** Epoch MILLISECONDS when this window's quota resets; 0 if unknown. */
  resets_at: number;
}

/** One agent row in the local report: which agent, its detection status, remaining windows, totals. */
export interface AgentUsageReport {
  /** Stable agent key matching AgentType; used to key rows and pick the label. */
  agent: AgentType;
  status: UsageStatus;
  /** Today's token totals (kept for the tooltip on every agent, even when `windows` is absent). */
  usage: AgentUsage;
  /** Remaining rate-limit windows — present only for Codex with a snapshot (`status === 'ok'`). */
  windows?: RateWindow[];
  /** Present only when `status === 'error'` — a short human-readable reason. */
  error?: string;
}

/**
 * The local CLI report served by `GET /api/usage/local` and rendered in the sidebar footer. Each
 * agent is read + aggregated independently so one failing CLI never blanks the other. `generated_at`
 * is when the server computed the snapshot; "today" (used for the tooltip totals) is the server's
 * local-machine day (Symphony runs locally beside the CLIs).
 */
export interface LocalUsageReport {
  generated_at: string; // ISO
  agents: AgentUsageReport[];
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
