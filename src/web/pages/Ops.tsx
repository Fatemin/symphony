import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, History, RefreshCw, Zap } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, EmptyState, Input, PageHeader, Panel, Select } from '../components/ui';
import { fmtDuration, relativeFuture, relativeTime, STATUS_META } from '../lib/format';
import type { IssueStatus, OpsHistoryRow, RunStatus } from '../../shared/types';

export function Ops() {
  const qc = useQueryClient();
  const { data: snap } = useQuery({
    queryKey: ['snapshot'],
    queryFn: api.ops.snapshot,
    refetchInterval: 2000,
  });
  const { data: history } = useQuery({
    queryKey: ['ops-history'],
    queryFn: () => api.ops.history(),
    refetchInterval: 5000,
  });
  const kick = useMutation({ mutationFn: api.ops.kick, onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshot'] }) });

  return (
    <div className="mx-auto max-w-5xl p-6 sm:p-8">
      <PageHeader
        title="Orchestrator"
        icon={<Activity className="h-5 w-5 text-indigo-400" />}
        actions={
          <>
            <Badge tone={snap?.enabled ? 'success' : 'danger'}>{snap?.enabled ? 'enabled' : 'disabled'}</Badge>
            <Button onClick={() => kick.mutate()}>
              <Zap className="h-4 w-4" /> Kick
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Running" value={snap?.running.length ?? 0} />
        <Stat label="Retrying" value={snap?.retrying.length ?? 0} />
        <Stat label="Total tokens" value={(snap?.totals.total_tokens ?? 0).toLocaleString()} />
        <Stat label="Agent runtime" value={fmtDuration(snap?.totals.seconds_running ?? 0)} />
      </div>

      <Panel className="mb-5">
        <SectionHeader icon={<RefreshCw className="h-3.5 w-3.5" />} title="Running" count={snap?.running.length ?? 0} />
        {snap && snap.running.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Issue</th>
                  <th className="px-4 py-2 font-medium">Phase</th>
                  <th className="px-4 py-2 font-medium">Attempt</th>
                  <th className="px-4 py-2 font-medium">Turns</th>
                  <th className="px-4 py-2 font-medium">Tokens</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {snap.running.map((r) => (
                  <tr key={r.issue_id} className="border-t border-border">
                    <td className="px-4 py-2">
                      <Link to={`/issues/${r.issue_id}`} className="font-mono text-indigo-300 hover:underline">{r.issue_key}</Link>
                      <span className="ml-2 text-muted">{r.title}</span>
                    </td>
                    <td className="px-4 py-2"><Badge className="bg-amber-500/15 text-amber-300">{r.phase}</Badge></td>
                    <td className="px-4 py-2 text-muted">{r.attempt}</td>
                    <td className="px-4 py-2 text-muted">{r.num_turns}</td>
                    <td className="px-4 py-2 text-muted">{r.total_tokens.toLocaleString()}</td>
                    <td className="px-4 py-2 text-muted">{relativeTime(r.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing running.</Empty>
        )}
      </Panel>

      {snap && snap.retrying.length > 0 && (
        <Panel className="mb-5">
          <SectionHeader title="Retry queue" count={snap.retrying.length} />
          <div className="divide-y divide-border">
            {snap.retrying.map((r) => (
              <div key={r.issue_id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="font-mono text-fg">{r.issue_key}</span>
                <span className="text-xs text-muted">attempt {r.attempt} · due {relativeFuture(r.due_at)}</span>
                <span className="max-w-md truncate text-xs text-red-400/80">{r.error}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <HistoryPanel rows={history ?? []} />
    </div>
  );
}

// ── History ───────────────────────────────────────────────────────────────

type SortKey = 'recent' | 'tokens' | 'attempts' | 'duration';

/** Run statuses surfaced as the "outcome" of an issue's latest run. */
const RUN_STATUS_CLASS: Record<RunStatus, string> = {
  running: 'bg-amber-500/15 text-amber-300',
  succeeded: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  timeout: 'bg-red-500/15 text-red-300',
  stalled: 'bg-orange-500/15 text-orange-300',
  cancelled: 'bg-slate-500/15 text-muted',
};

/** Seconds spanned by an issue's runs (first start → last end); 0 while still open. */
function durationSecs(r: OpsHistoryRow): number {
  if (!r.started_at || !r.ended_at) return 0;
  return (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000;
}

/** Sort anchor for "recent": the issue's last activity (last run end, else issue update). */
function lastActivity(r: OpsHistoryRow): number {
  return new Date(r.ended_at ?? r.updated_at).getTime();
}

function HistoryPanel({ rows }: { rows: OpsHistoryRow[] }) {
  const [statusFilter, setStatusFilter] = useState<'all' | IssueStatus>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | RunStatus>('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [desc, setDesc] = useState(true);

  const projectKeys = useMemo(
    () => [...new Set(rows.map((r) => r.project_key))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (outcomeFilter !== 'all' && r.last_status !== outcomeFilter) return false;
      if (projectFilter !== 'all' && r.project_key !== projectFilter) return false;
      if (q && !r.issue_key.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
    const cmp = (a: OpsHistoryRow, b: OpsHistoryRow): number => {
      switch (sort) {
        case 'tokens': return a.total_tokens - b.total_tokens;
        case 'attempts': return a.attempts - b.attempts;
        case 'duration': return durationSecs(a) - durationSecs(b);
        case 'recent': default: return lastActivity(a) - lastActivity(b);
      }
    };
    return [...filtered].sort((a, b) => (desc ? -1 : 1) * cmp(a, b));
  }, [rows, statusFilter, outcomeFilter, projectFilter, search, sort, desc]);

  return (
    <Panel>
      <SectionHeader icon={<History className="h-3.5 w-3.5" />} title="History" count={visible.length} />

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Input
          placeholder="Search issue / title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-48"
        />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | IssueStatus)} className="w-auto">
          <option value="all">All statuses</option>
          {(Object.keys(STATUS_META) as IssueStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_META[s].label}</option>
          ))}
        </Select>
        <Select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value as 'all' | RunStatus)} className="w-auto">
          <option value="all">All outcomes</option>
          {(Object.keys(RUN_STATUS_CLASS) as RunStatus[]).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
        <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="w-auto">
          <option value="all">All projects</option>
          {projectKeys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-auto">
            <option value="recent">Recent</option>
            <option value="tokens">Tokens</option>
            <option value="attempts">Attempts</option>
            <option value="duration">Duration</option>
          </Select>
          <Button onClick={() => setDesc((d) => !d)} title="Toggle sort direction">
            {desc ? '↓ Desc' : '↑ Asc'}
          </Button>
        </div>
      </div>

      {visible.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Issue</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
                <th className="px-4 py-2 font-medium">Attempts</th>
                <th className="px-4 py-2 font-medium">Turns</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2 font-medium">Ended</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.issue_id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <Link to={`/issues/${r.issue_id}`} className="font-mono text-indigo-300 hover:underline">{r.issue_key}</Link>
                    <span className="ml-2 text-muted">{r.title}</span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted">{r.project_key}</td>
                  <td className="px-4 py-2 text-muted">{r.type}</td>
                  <td className="px-4 py-2">
                    <span className={STATUS_META[r.status].color}>{STATUS_META[r.status].label}</span>
                  </td>
                  <td className="px-4 py-2">
                    {r.last_status ? (
                      <Badge className={RUN_STATUS_CLASS[r.last_status]}>
                        {r.last_phase ? `${r.last_phase} · ${r.last_status}` : r.last_status}
                      </Badge>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted">{r.attempts}</td>
                  <td className="px-4 py-2 text-muted">{r.num_turns}</td>
                  <td className="px-4 py-2 text-muted">{r.total_tokens.toLocaleString()}</td>
                  <td className="px-4 py-2 text-muted">{r.ended_at ? fmtDuration(durationSecs(r)) : '—'}</td>
                  <td className="px-4 py-2 text-muted">{r.ended_at ? relativeTime(r.ended_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{rows.length === 0 ? 'No completed runs yet.' : 'No issues match these filters.'}</Empty>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Panel className="p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </Panel>
  );
}

function SectionHeader({ title, count, icon }: { title: string; count: number; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-medium text-muted">
      {icon} {title} <span className="text-subtle">{count}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <EmptyState compact title={children} />;
}
