import type {
  IssueStatus,
  Priority,
  ProjectSkillSource,
  ReviewCategory,
  ReviewScope,
  ReviewSeverity,
  ReviewStatus,
  RunPhase,
} from '../../shared/types';

export const STATUS_ORDER: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

export const STATUS_META: Record<IssueStatus, { label: string; color: string; dot: string }> = {
  backlog: { label: 'Backlog', color: 'text-muted', dot: 'bg-slate-500' },
  todo: { label: 'Todo', color: 'text-[var(--color-todo)]', dot: 'bg-sky-500' },
  in_progress: { label: 'In Progress', color: 'text-[var(--color-progress)]', dot: 'bg-amber-400' },
  review: { label: 'Review', color: 'text-[var(--color-review)]', dot: 'bg-violet-400' },
  done: { label: 'Done', color: 'text-[var(--color-done)]', dot: 'bg-emerald-500' },
  cancelled: { label: 'Cancelled', color: 'text-muted', dot: 'bg-slate-600' },
};

// SYM-32: phase chip styling for an in-progress issue's board card. Keyed over every RunPhase so a
// new phase forces a label here. `badge` matches the footer chip shape (rounded px-1.5 py-0.5) and
// uses the amber in-progress theme so the chip reads as "active work".
export const PHASE_META: Record<RunPhase, { label: string; badge: string }> = {
  plan: { label: 'Plan', badge: 'bg-amber-400/15 text-amber-300' },
  implement: { label: 'Implement', badge: 'bg-amber-400/15 text-amber-300' },
  qa: { label: 'QA', badge: 'bg-amber-400/15 text-amber-300' },
  delivery: { label: 'Delivery', badge: 'bg-amber-400/15 text-amber-300' },
  merge: { label: 'Merge', badge: 'bg-amber-400/15 text-amber-300' },
};

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  0: { label: 'None', color: 'text-muted' },
  1: { label: 'Urgent', color: 'text-[var(--color-urgent)]' },
  2: { label: 'High', color: 'text-[var(--color-high)]' },
  3: { label: 'Medium', color: 'text-[var(--color-medium)]' },
  4: { label: 'Low', color: 'text-muted' },
};

export function relativeTime(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** Forward-looking counterpart to relativeTime, for future timestamps (e.g. a retry's due_at). */
export function relativeFuture(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const secs = Math.round((then - Date.now()) / 1000);
  if (secs <= 0) return 'now';
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Compact token count for tight UI (e.g. the sidebar usage footer): 820 → "820", 45 300 → "45.3K",
 * 1 200 000 → "1.2M". One decimal place, trailing ".0" trimmed; negatives clamped to 0.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  const [value, suffix] = n < 1_000_000 ? [n / 1_000, 'K'] : [n / 1_000_000, 'M'];
  return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

/**
 * Compact percentage for tight UI (e.g. the sidebar "Remaining" figure, SYM-39): clamped to 0–100 and
 * rounded to a whole number with a '%' suffix. 83.4 → "83%", 120 → "100%", -5 → "0%", NaN → "0%".
 */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  return `${Math.round(Math.max(0, Math.min(100, n)))}%`;
}

// ── Project review (SYM-51) ────────────────────────────────────────────────

/** Render order / grade ranking of a finding's severity (most important first). */
export const REVIEW_SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Severity styling for a finding card: a label, a chip class (matches PHASE_META's chip shape), a dot
 * color, and a `rail` left-border accent. `rank` drives the within-batch ordering so the most urgent
 * findings surface first. SYM-61: `rail` is the card's data-driven grade rail — it mirrors the dot's
 * color family so the rail reads as quiet reinforcement of the labeled group header (color is never
 * the only severity signal).
 */
export const REVIEW_SEVERITY_META: Record<
  ReviewSeverity,
  { label: string; badge: string; dot: string; rail: string; rank: number }
> = {
  critical: { label: 'Critical', badge: 'bg-red-500/15 text-red-300', dot: 'bg-red-500', rail: 'border-l-red-500/70', rank: 0 },
  high: { label: 'High', badge: 'bg-orange-500/15 text-orange-300', dot: 'bg-orange-400', rail: 'border-l-orange-400/70', rank: 1 },
  medium: { label: 'Medium', badge: 'bg-amber-400/15 text-amber-300', dot: 'bg-amber-400', rail: 'border-l-amber-400/70', rank: 2 },
  low: { label: 'Low', badge: 'bg-slate-500/20 text-slate-300', dot: 'bg-slate-500', rail: 'border-l-slate-500/60', rank: 3 },
};

/** Scope picker + batch-header labels. `all` runs all three areas and tags each finding. */
export const REVIEW_SCOPE_META: Record<ReviewScope, { label: string; hint: string }> = {
  docs: { label: 'Docs', hint: 'Accuracy, completeness, and drift vs the code' },
  code: { label: 'Code', hint: 'Correctness, architecture, security, performance, tests' },
  ui_ux: { label: 'UI / UX', hint: 'Accessibility, every state, responsiveness, design consistency' },
  all: { label: 'Full review', hint: 'Docs + code + UI/UX in one pass, each finding tagged' },
};

/** A finding's category chip (the scope set minus `all`); shown on full-review cards to tag the area. */
export const REVIEW_CATEGORY_META: Record<ReviewCategory, { label: string; badge: string }> = {
  docs: { label: 'Docs', badge: 'bg-sky-500/15 text-sky-300' },
  code: { label: 'Code', badge: 'bg-violet-500/15 text-violet-300' },
  ui_ux: { label: 'UI / UX', badge: 'bg-teal-500/15 text-teal-300' },
};

/** Batch lifecycle styling for the run header (dot + label). */
export const REVIEW_STATUS_META: Record<ReviewStatus, { label: string; color: string; dot: string }> =
  {
    running: { label: 'Running', color: 'text-amber-300', dot: 'bg-amber-400' },
    completed: { label: 'Completed', color: 'text-emerald-400', dot: 'bg-emerald-500' },
    failed: { label: 'Failed', color: 'text-red-400', dot: 'bg-red-500' },
  };

// ── Project skills (SYM-63) ────────────────────────────────────────────────

/**
 * Source styling for a skill card's origin badge AND the source-filter option list (SYM-63). Mirrors
 * the REVIEW_*_META shape so the badge and the filter dropdown share one source of truth instead of
 * the old inline `sourceBadgeClass`. `badge` keeps the pre-existing indigo / emerald / neutral chip
 * classes (consistent with REVIEW_*_META, which likewise carries raw color classes) so the redesign is
 * purely structural — no visual regression on existing cards.
 */
export const SKILL_SOURCE_META: Record<ProjectSkillSource, { label: string; badge: string }> = {
  manual: { label: 'Manual', badge: 'bg-panel-2 text-muted' },
  github: { label: 'GitHub', badge: 'bg-indigo-500/15 text-indigo-300' },
  marketplace: { label: 'Marketplace', badge: 'bg-emerald-500/15 text-emerald-300' },
};
