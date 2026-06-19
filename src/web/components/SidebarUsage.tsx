import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { formatPercent, formatTokens } from '../lib/format';
import type { AgentType, AgentUsage, AgentUsageReport, Issue, RateWindow } from '../../shared/types';

/**
 * SYM-38 / SYM-39: sidebar footer widget. SYM-39 repurposed it from today's token *usage* to
 * **remaining** rate-limit quota — the user wants to see what's left, not what's spent.
 *
 * Codex logs its live rate limits locally, so its row headlines the lowest remaining window
 * ("NN% left") with a threshold-colored dot and a per-window/reset tooltip. Claude exposes NO local
 * quota state, so instead of fabricating a budget — or, as before, showing a flat "本地不可用" that
 * misread as "Claude Code is unavailable" (SYM-40) — its row honestly falls back to today's token
 * usage ("N 今日", self-qualified so it isn't mistaken for a remaining %) with a neutral dot, or a
 * neutral idle label ("无今日用量") when nothing ran today. The tooltip explains that remaining quota
 * isn't derivable locally (run `/usage` in the Claude CLI).
 *
 * Refreshes on two triggers (AC#2 from SYM-38): a 60s interval, and whenever any issue takes an
 * action — the latter by reading the SAME `['issues']` query Layout already polls every 3s (TanStack
 * dedupes) and invalidating the usage query when the issues' status/updated_at signature changes.
 *
 * Every state is rendered (AC#1/#3): loading, ok (remaining %), empty (no recent activity),
 * unsupported (Claude → today's usage / idle), not_found (not detected), and error → "检测失败 /
 * detection failed". Each agent is read independently server-side, so one missing CLI never blanks the
 * other; a whole-query failure shows 检测失败 on both.
 */
export function SidebarUsage() {
  const qc = useQueryClient();

  const usageQuery = useQuery({
    queryKey: ['usage', 'local'],
    queryFn: api.usage.local,
    refetchInterval: 60_000,
  });

  // Read (not re-declare) the shared issues poll so this stays a passive observer of the cache.
  const { data: issues = [] } = useQuery({ queryKey: ['issues'], queryFn: () => api.issues.list() });
  const issuesSignature = useMemo(
    () => issues.map((i: Issue) => `${i.id}:${i.status}:${i.updated_at}`).join('|'),
    [issues],
  );
  // Invalidate on every change AFTER the first observed signature (the initial fetch already covers mount).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    qc.invalidateQueries({ queryKey: ['usage', 'local'] });
  }, [issuesSignature, qc]);

  const report = usageQuery.data;
  const queryFailed = usageQuery.isError;
  const loading = usageQuery.isLoading;
  const byAgent = (agent: AgentType): AgentUsageReport | null =>
    report?.agents.find((a) => a.agent === agent) ?? null;

  return (
    <div className="text-[11px] leading-relaxed">
      <div
        className="mb-1 text-[10px] font-medium uppercase tracking-wide text-subtle"
        title={report?.generated_at ? `Updated ${new Date(report.generated_at).toLocaleString()}` : undefined}
      >
        Remaining
      </div>
      <div className="space-y-0.5">
        {AGENTS.map((agent) => (
          <UsageRow
            key={agent}
            label={AGENT_LABEL[agent]}
            report={queryFailed ? null : byAgent(agent)}
            loading={loading}
            queryFailed={queryFailed}
            generatedAt={report?.generated_at}
          />
        ))}
      </div>
    </div>
  );
}

const AGENTS: AgentType[] = ['claude', 'codex'];
const AGENT_LABEL: Record<AgentType, string> = { claude: 'Claude Code', codex: 'Codex' };

interface RowDisplay {
  text: string;
  dot: string; // tailwind bg-* class
  strong: boolean; // emphasize the value (ok / error) vs. dim it (idle states)
  title?: string;
}

function UsageRow({
  label,
  report,
  loading,
  queryFailed,
  generatedAt,
}: {
  label: string;
  report: AgentUsageReport | null;
  loading: boolean;
  queryFailed: boolean;
  generatedAt?: string;
}) {
  const d = rowDisplay(report, loading, queryFailed, generatedAt);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-muted">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5" title={d.title}>
        <span className={d.strong ? 'text-fg' : 'text-subtle'}>{d.text}</span>
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.dot}`} />
      </span>
    </div>
  );
}

function rowDisplay(
  report: AgentUsageReport | null,
  loading: boolean,
  queryFailed: boolean,
  generatedAt?: string,
): RowDisplay {
  if (queryFailed) return { text: '检测失败', dot: 'bg-amber-400', strong: true, title: 'Detection failed' };
  if (loading || !report) return { text: '…', dot: 'bg-slate-600', strong: false };

  switch (report.status) {
    case 'ok': {
      const windows = report.windows ?? [];
      const minRemaining = windows.length > 0 ? Math.min(...windows.map((w) => w.remaining_percent)) : 0;
      return {
        text: `${formatPercent(minRemaining)} left`,
        dot: remainingDot(minRemaining),
        strong: true,
        title: remainingTitle(report, windows, generatedAt),
      };
    }
    case 'empty':
      return {
        text: 'no recent activity',
        dot: 'bg-slate-500',
        strong: false,
        title: 'Detected, but no recent rate-limit data logged',
      };
    case 'unsupported': {
      // SYM-40: Claude IS in active use; showing "本地不可用" misreads as "Claude Code unavailable".
      // Remaining quota genuinely isn't derivable from Claude's logs, so we honestly fall back to
      // today's token usage (self-qualified with 今日 so it isn't mistaken for a remaining %) and a
      // neutral dot — never a quota signal. The tooltip carries the "run /usage" explanation.
      const today = report.usage.total_tokens;
      return today > 0
        ? { text: `${formatTokens(today)} 今日`, dot: 'bg-slate-600', strong: true, title: unsupportedTitle(report, generatedAt) }
        : { text: '无今日用量', dot: 'bg-slate-600', strong: false, title: unsupportedTitle(report, generatedAt) };
    }
    case 'not_found':
      return { text: 'not detected', dot: 'bg-slate-600', strong: false, title: 'CLI data directory not found on this machine' };
    case 'error':
      return { text: '检测失败', dot: 'bg-amber-400', strong: true, title: report.error || 'Detection failed' };
    default:
      return { text: '…', dot: 'bg-slate-600', strong: false };
  }
}

/** Dot color by remaining headroom: healthy >50, getting low 20–50, critical <20. */
function remainingDot(remaining: number): string {
  if (remaining > 50) return 'bg-emerald-500';
  if (remaining >= 20) return 'bg-amber-400';
  return 'bg-red-500';
}

/** Codex tooltip: per-window remaining + reset, then today's tokens, then the snapshot time. */
function remainingTitle(report: AgentUsageReport, windows: RateWindow[], generatedAt?: string): string {
  const lines = windows.map((w) => {
    const reset = w.resets_at > 0 ? ` · resets ${formatReset(w.resets_at)}` : '';
    return `${windowLabel(w)} ${formatPercent(w.remaining_percent)} left${reset}`;
  });
  if (report.usage.total_tokens > 0) lines.push(todayUsageLine(report.usage));
  if (generatedAt) lines.push(`Updated ${new Date(generatedAt).toLocaleTimeString()}`);
  return lines.join('\n');
}

/** Claude tooltip: an honest explanation that remaining isn't available locally, plus today's tokens. */
function unsupportedTitle(report: AgentUsageReport, generatedAt?: string): string {
  const lines = ['本地无法获取 Claude 剩余量,请在 Claude CLI 运行 /usage'];
  if (report.usage.total_tokens > 0) lines.push(todayUsageLine(report.usage));
  if (generatedAt) lines.push(`Updated ${new Date(generatedAt).toLocaleTimeString()}`);
  return lines.join('\n');
}

function todayUsageLine(u: AgentUsage): string {
  const cache = u.cache_read_tokens + u.cache_creation_tokens;
  return `Today · in ${formatTokens(u.input_tokens)} · out ${formatTokens(u.output_tokens)} · cache ${formatTokens(cache)}`;
}

/** Short label for a window: prefer its known length, fall back to the slot name. */
function windowLabel(w: RateWindow): string {
  const m = w.window_minutes;
  if (m === 300) return '5h';
  if (m === 10080) return 'Week';
  if (m > 0) {
    const hrs = m / 60;
    if (hrs >= 24) return `${Math.round(hrs / 24)}d`;
    if (Number.isInteger(hrs)) return `${hrs}h`;
    return `${Math.round(m)}m`;
  }
  return w.key === 'primary' ? '5h' : 'Week';
}

/** A reset within ~a day shows a clock time; further out shows a short date. */
function formatReset(ms: number): string {
  const d = new Date(ms);
  const delta = ms - Date.now();
  const withinDay = delta > -60_000 && delta < 24 * 60 * 60 * 1000;
  return withinDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
