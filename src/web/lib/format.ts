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
  backlog: { label: 'Backlog', color: 'text-slate-400', dot: 'bg-slate-500' },
  todo: { label: 'Todo', color: 'text-sky-300', dot: 'bg-sky-500' },
  in_progress: { label: 'In Progress', color: 'text-amber-300', dot: 'bg-amber-400' },
  review: { label: 'Review', color: 'text-violet-300', dot: 'bg-violet-400' },
  done: { label: 'Done', color: 'text-emerald-300', dot: 'bg-emerald-500' },
  cancelled: { label: 'Cancelled', color: 'text-slate-500', dot: 'bg-slate-600' },
};

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  0: { label: 'None', color: 'text-slate-500' },
  1: { label: 'Urgent', color: 'text-red-400' },
  2: { label: 'High', color: 'text-orange-300' },
  3: { label: 'Medium', color: 'text-yellow-300' },
  4: { label: 'Low', color: 'text-slate-400' },
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
