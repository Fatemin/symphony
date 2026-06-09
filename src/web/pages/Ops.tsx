import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw, Zap } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Panel } from '../components/ui';
import { fmtDuration, relativeTime } from '../lib/format';

export function Ops() {
  const qc = useQueryClient();
  const { data: snap } = useQuery({
    queryKey: ['snapshot'],
    queryFn: api.ops.snapshot,
    refetchInterval: 2000,
  });
  const kick = useMutation({ mutationFn: api.ops.kick, onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshot'] }) });

  return (
    <div className="mx-auto max-w-5xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Activity className="h-5 w-5 text-indigo-400" /> Orchestrator
        </h1>
        <div className="flex items-center gap-2">
          <Badge className={snap?.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}>
            {snap?.enabled ? 'enabled' : 'disabled'}
          </Badge>
          <Button onClick={() => kick.mutate()}>
            <Zap className="h-4 w-4" /> Kick
          </Button>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Running" value={snap?.running.length ?? 0} />
        <Stat label="Retrying" value={snap?.retrying.length ?? 0} />
        <Stat label="Total tokens" value={(snap?.totals.total_tokens ?? 0).toLocaleString()} />
        <Stat label="Agent runtime" value={fmtDuration(snap?.totals.seconds_running ?? 0)} />
      </div>

      <Panel className="mb-5">
        <SectionHeader icon={<RefreshCw className="h-3.5 w-3.5" />} title="Running" count={snap?.running.length ?? 0} />
        {snap && snap.running.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-slate-600">
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
                <tr key={r.issue_id} className="border-t border-[#262b38]">
                  <td className="px-4 py-2">
                    <Link to={`/issues/${r.issue_id}`} className="font-mono text-indigo-300 hover:underline">{r.issue_key}</Link>
                    <span className="ml-2 text-slate-400">{r.title}</span>
                  </td>
                  <td className="px-4 py-2"><Badge className="bg-amber-500/15 text-amber-300">{r.phase}</Badge></td>
                  <td className="px-4 py-2 text-slate-400">{r.attempt}</td>
                  <td className="px-4 py-2 text-slate-400">{r.num_turns}</td>
                  <td className="px-4 py-2 text-slate-400">{r.total_tokens.toLocaleString()}</td>
                  <td className="px-4 py-2 text-slate-500">{relativeTime(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing running.</Empty>
        )}
      </Panel>

      {snap && snap.retrying.length > 0 && (
        <Panel>
          <SectionHeader title="Retry queue" count={snap.retrying.length} />
          <div className="divide-y divide-[#262b38]">
            {snap.retrying.map((r) => (
              <div key={r.issue_id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="font-mono text-slate-300">{r.issue_key}</span>
                <span className="text-xs text-slate-500">attempt {r.attempt} · due {relativeTime(r.due_at)}</span>
                <span className="max-w-md truncate text-xs text-red-400/80">{r.error}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Panel className="p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </Panel>
  );
}

function SectionHeader({ title, count, icon }: { title: string; count: number; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-[#262b38] px-4 py-2.5 text-xs font-medium text-slate-400">
      {icon} {title} <span className="text-slate-600">{count}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-slate-600">{children}</p>;
}
