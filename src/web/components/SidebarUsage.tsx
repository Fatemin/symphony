import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { formatTokens } from '../lib/format';
import type { AgentType, AgentUsageReport, Issue } from '../../shared/types';

/**
 * SYM-38: sidebar footer widget showing today's LOCAL Claude Code / Codex token usage.
 *
 * Refreshes on two triggers (AC#2): a 60s interval, and whenever any issue takes an action — the
 * latter by reading the SAME `['issues']` query Layout already polls every 3s (TanStack dedupes) and
 * invalidating the usage query when the issues' status/updated_at signature changes.
 *
 * Every state is rendered (AC#1/#3): loading, ok (figure), empty (no usage today), not_found (not
 * detected), and error → "检测失败 / detection failed". Each agent is read independently server-side,
 * so one missing CLI never blanks the other row; a whole-query failure shows 检测失败 on both.
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
      <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-subtle">
        <span>Local usage</span>
        <span title={report?.generated_at ? `Updated ${new Date(report.generated_at).toLocaleString()}` : undefined}>
          today
        </span>
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
    case 'ok':
      return {
        text: formatTokens(report.usage.total_tokens),
        dot: 'bg-emerald-500',
        strong: true,
        title: okTitle(report, generatedAt),
      };
    case 'empty':
      return { text: 'no usage today', dot: 'bg-slate-500', strong: false, title: 'Detected, but no tokens logged today' };
    case 'not_found':
      return { text: 'not detected', dot: 'bg-slate-600', strong: false, title: 'CLI data directory not found on this machine' };
    case 'error':
      return { text: '检测失败', dot: 'bg-amber-400', strong: true, title: report.error || 'Detection failed' };
    default:
      return { text: '…', dot: 'bg-slate-600', strong: false };
  }
}

function okTitle(report: AgentUsageReport, generatedAt?: string): string {
  const u = report.usage;
  const cache = u.cache_read_tokens + u.cache_creation_tokens;
  const breakdown = `Input ${u.input_tokens.toLocaleString()} · Output ${u.output_tokens.toLocaleString()} · Cache ${cache.toLocaleString()}`;
  return generatedAt ? `${breakdown}\nUpdated ${new Date(generatedAt).toLocaleTimeString()}` : breakdown;
}
