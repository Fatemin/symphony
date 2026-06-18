import type { IssueStatus, Priority } from '../../shared/types';

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

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
