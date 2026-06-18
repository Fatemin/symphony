import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, CheckCircle2, CircleSlash, ExternalLink, FileDiff, MonitorPlay, Play, Square, XCircle } from 'lucide-react';
import type { Event, IssueStatus } from '../../shared/types';
import { api, streamIssue, type ApproveOptions, type IssueDetail as Detail } from '../api';
import { ApproveDialog } from '../components/ApproveDialog';
import { Badge, Button, Panel, Select, Spinner, Textarea } from '../components/ui';
import { PRIORITY_META, relativeTime, STATUS_META } from '../lib/format';

type LiveEvent = Event & { cursor: number };

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: issue } = useQuery({
    queryKey: ['issue', id],
    queryFn: () => api.issues.get(id!),
    refetchInterval: (q) => (isRunning(q.state.data?.status) ? 2000 : false),
  });

  if (!issue) return <div className="p-8 text-sm text-slate-500">Loading…</div>;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-3 gap-6 p-6">
      <div className="col-span-2 space-y-5">
        <Header issue={issue} onChange={() => qc.invalidateQueries({ queryKey: ['issue', id] })} />
        {(issue.status === 'review' || issue.status === 'done') && <ReviewPanel issue={issue} />}
        <Body issue={issue} onSaved={() => qc.invalidateQueries({ queryKey: ['issue', id] })} />
        <Tasks issue={issue} />
        <Runs issue={issue} />
      </div>
      <div className="col-span-1">
        <Activity issueId={issue.id} initial={issue.events} />
      </div>
    </div>
  );
}

const isRunning = (s?: IssueStatus) => s === 'in_progress';

function Header({ issue, onChange }: { issue: Detail; onChange: () => void }) {
  const [approveOpen, setApproveOpen] = useState(false);
  const update = useMutation({
    mutationFn: (patch: Partial<Detail>) => api.issues.update(issue.id, patch),
    onSuccess: onChange,
    onError: (e) => toast.error(String(e)),
  });
  const run = useMutation({
    mutationFn: () => api.issues.run(issue.id),
    onSuccess: (r) => (r.ok ? toast.success('Dispatched') : toast.error(r.reason ?? 'Could not run')),
    onError: (e) => toast.error(String(e)),
  });
  const approve = useMutation({
    mutationFn: (options: ApproveOptions) => api.issues.approve(issue.id, options),
    onSuccess: (r) => {
      if (r.ok && r.pr_url) toast.success(`PR opened: ${r.pr_url}`);
      else if (r.ok) toast.success(`Merged into ${r.target_branch ?? 'target branch'}${r.commit ? ` (${r.commit})` : ''} — done`);
      else toast.error(r.reason ?? 'Approve failed');
      setApproveOpen(false);
      onChange();
    },
    onError: (e) => toast.error(String(e)),
  });

  const meta = STATUS_META[issue.status];
  return (
    <div>
      <Link to={`/projects/${issue.project_id}`} className="mb-3 inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Board
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-mono text-slate-500">{issue.key}</span>
            <span className={`inline-flex items-center gap-1 ${meta.color}`}>
              <span className={`h-2 w-2 rounded-full ${meta.dot}`} /> {meta.label}
            </span>
            <span className={PRIORITY_META[issue.priority].color}>{PRIORITY_META[issue.priority].label}</span>
          </div>
          <h1 className="text-xl font-semibold leading-tight">{issue.title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={issue.mode}
            onChange={(e) => update.mutate({ mode: e.target.value as Detail['mode'] })}
            className="w-auto"
            title="auto = orchestrator auto-dispatches"
          >
            <option value="manual">manual</option>
            <option value="auto">auto</option>
          </Select>
          {issue.status === 'review' ? (
            <>
              <Button
                variant="subtle"
                disabled={run.isPending}
                onClick={() => run.mutate()}
                title="Re-run the pipeline on the same branch/worktree — update the description with what to change first"
              >
                {run.isPending ? <Spinner /> : <Play className="h-4 w-4" />} Re-run
              </Button>
              <Button variant="primary" disabled={approve.isPending} onClick={() => setApproveOpen(true)} title={`Merge ${issue.branch_name} and mark done`}>
                {approve.isPending ? <Spinner /> : <Check className="h-4 w-4" />} Approve & merge
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={isRunning(issue.status) || run.isPending} onClick={() => run.mutate()}>
              {isRunning(issue.status) ? <Spinner /> : <Play className="h-4 w-4" />} Run
            </Button>
          )}
          {issue.status !== 'cancelled' && issue.status !== 'done' && (
            <Button variant="ghost" title="Cancel" onClick={() => update.mutate({ status: 'cancelled' })}>
              <CircleSlash className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {approveOpen && (
        <ApproveDialog
          projectId={issue.project_id}
          initialBranch={issue.base_branch ?? 'main'}
          count={1}
          pending={approve.isPending}
          onCancel={() => setApproveOpen(false)}
          onConfirm={(options) => approve.mutate(options)}
        />
      )}
    </div>
  );
}

function Body({ issue, onSaved }: { issue: Detail; onSaved: () => void }) {
  const [desc, setDesc] = useState(issue.description ?? '');
  const [ac, setAc] = useState(issue.acceptance_criteria ?? '');
  const dirty = desc !== (issue.description ?? '') || ac !== (issue.acceptance_criteria ?? '');
  const save = useMutation({
    mutationFn: () => api.issues.update(issue.id, { description: desc, acceptance_criteria: ac }),
    onSuccess: () => { onSaved(); toast.success('Saved'); },
  });

  return (
    <Panel className="space-y-4 p-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-400">Description</p>
        <Textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-400">Acceptance criteria</p>
        <Textarea rows={4} value={ac} onChange={(e) => setAc(e.target.value)} />
      </div>
      {dirty && (
        <div className="flex justify-end">
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      )}
    </Panel>
  );
}

function Tasks({ issue }: { issue: Detail }) {
  if (issue.tasks.length === 0) return null;
  return (
    <Panel className="p-4">
      <p className="mb-3 text-xs font-medium text-slate-400">Plan ({issue.tasks.length} tasks)</p>
      <ul className="space-y-1.5">
        {issue.tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm">
            <span className={`h-3.5 w-3.5 rounded-sm border ${t.status === 'done' ? 'border-emerald-500 bg-emerald-500/30' : t.status === 'failed' ? 'border-red-500 bg-red-500/20' : t.status === 'running' ? 'border-amber-400' : 'border-slate-600'}`} />
            <span className="rounded bg-[#1b1f2a] px-1.5 py-0.5 text-[10px] text-slate-400">{t.role}</span>
            <span className={t.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-200'}>{t.title}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Runs({ issue }: { issue: Detail }) {
  if (issue.runs.length === 0) return null;
  return (
    <Panel className="p-4">
      <p className="mb-3 text-xs font-medium text-slate-400">Runs</p>
      <div className="space-y-1.5">
        {issue.runs.map((r) => (
          <div key={r.id} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-20 font-mono text-slate-400">{r.phase}</span>
              <Badge className={r.status === 'succeeded' ? 'bg-emerald-500/15 text-emerald-300' : r.status === 'running' ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300'}>
                {r.status}
              </Badge>
              <span className="text-slate-600">att {r.attempt}</span>
            </div>
            <span className="text-slate-600">{r.total_tokens.toLocaleString()} tok · {r.num_turns} turns</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ReviewPanel({ issue }: { issue: Detail }) {
  // ── QA verdict + evidence (item 2), derived from existing runs/events ──
  const qaRun = issue.runs.find((r) => r.phase === 'qa');
  const pass = qaRun?.status === 'succeeded';
  const phaseOf = (e: LiveEvent) => (e.data as { phase?: string } | null)?.phase;
  const verdict = issue.events.find((e) => e.kind === 'phase.end' && phaseOf(e) === 'qa')?.message;
  const qaActivity = issue.events.filter((e) => phaseOf(e) === 'qa' && e.kind === 'agent.tool');

  // ── diff (item 1) ──
  const { data: diff, isLoading } = useQuery({
    queryKey: ['diff', issue.id],
    queryFn: () => api.issues.diff(issue.id),
  });

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-slate-400">
        <FileDiff className="h-3.5 w-3.5" /> Review evidence
      </div>

      {/* Verdict */}
      {qaRun && (
        <div className={`mb-3 flex items-start gap-2 rounded-md px-3 py-2 ${pass ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
          {pass ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> : <XCircle className="mt-0.5 h-4 w-4 text-red-400" />}
          <div className="text-sm">
            <span className={pass ? 'font-medium text-emerald-300' : 'font-medium text-red-300'}>
              QA {pass ? 'PASS' : 'FAIL'}
            </span>
            <span className="text-slate-400"> — {(verdict ?? '').replace(/^QA (PASS|FAIL)\s*[—-]?\s*/i, '') || 'self-QA verdict'}</span>
          </div>
        </div>
      )}

      {/* What the QA agent ran (evidence the checks actually executed) */}
      {qaActivity.length > 0 && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
            QA ran {qaActivity.length} step(s)
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-2">
            {qaActivity.slice(0, 12).map((e) => (
              <li key={e.cursor} className="truncate font-mono text-[11px] text-slate-500">
                {e.message.replace(/^qa:\s*/, '')}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Live preview (only while the worktree still exists, i.e. before approval) */}
      {issue.status === 'review' && <Preview issueId={issue.id} />}

      {/* Diff */}
      <div className="text-xs">
        {isLoading ? (
          <span className="text-slate-600">Loading diff…</span>
        ) : !diff?.available ? (
          <span className="text-slate-600">No diff (no committed changes on the agent branch).</span>
        ) : (
          <Diff diff={diff} />
        )}
      </div>
    </Panel>
  );
}

function Preview({ issueId }: { issueId: string }) {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['preview', issueId],
    queryFn: () => api.issues.preview.status(issueId),
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
  const start = useMutation({
    mutationFn: () => api.issues.preview.start(issueId),
    onSuccess: (s) => {
      if (s.error) toast.error(s.error);
      else toast.success('Preview starting — give it a few seconds to boot');
      qc.invalidateQueries({ queryKey: ['preview', issueId] });
    },
    onError: (e) => toast.error(String(e)),
  });
  const stop = useMutation({
    mutationFn: () => api.issues.preview.stop(issueId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview', issueId] }),
  });

  return (
    <div className="mb-3 rounded-md border border-[#262b38] bg-[#0f1218] p-2.5 text-xs">
      {status?.running ? (
        <div>
          <div className="flex items-center justify-between">
            <a href={status.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-indigo-300 hover:underline">
              <ExternalLink className="h-3.5 w-3.5" /> {status.url}
            </a>
            <Button variant="ghost" className="px-2 py-1" onClick={() => stop.mutate()}>
              <Square className="h-3 w-3" /> Stop
            </Button>
          </div>
          <p className="mt-1 font-mono text-[10px] text-slate-600">{status.command}</p>
          {status.output && (
            <pre className="mt-1.5 max-h-28 overflow-auto rounded bg-[#0b0d12] p-2 font-mono text-[10px] text-slate-500">
              {status.output.slice(-1500)}
            </pre>
          )}
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Launch the project from this worktree to click through it.</span>
            <Button variant="subtle" className="px-2 py-1" disabled={start.isPending} onClick={() => start.mutate()}>
              <MonitorPlay className="h-3.5 w-3.5" /> Preview
            </Button>
          </div>
          {status?.error && (
            <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[#0b0d12] p-2 font-mono text-[10px] text-red-300">
              {status.error.slice(-1500)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Diff({ diff }: { diff: NonNullable<Awaited<ReturnType<typeof api.issues.diff>>> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-slate-500">
          {diff.files.length} file(s) changed on <span className="font-mono text-slate-400">{diff.branch}</span>
        </span>
        <button className="text-indigo-300 hover:underline" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide patch' : 'Show patch'}
        </button>
      </div>
      <ul className="mb-2 space-y-0.5">
        {diff.files.map((f) => (
          <li key={f.path} className="flex items-center gap-2 font-mono text-[11px]">
            <span className={`w-4 ${f.status[0] === 'A' ? 'text-emerald-400' : f.status[0] === 'D' ? 'text-red-400' : 'text-amber-400'}`}>
              {f.status[0]}
            </span>
            <span className="truncate text-slate-300">{f.path}</span>
          </li>
        ))}
      </ul>
      {open && (
        <pre className="max-h-96 overflow-auto rounded-md bg-[#0b0d12] p-3 font-mono text-[11px] leading-relaxed">
          {diff.patch.split('\n').map((line, i) => (
            <div key={i} className={diffLineColor(line)}>
              {line || ' '}
            </div>
          ))}
          {diff.truncated && <div className="mt-2 text-amber-500">… patch truncated (too large to display fully).</div>}
        </pre>
      )}
    </div>
  );
}

function diffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-emerald-300';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-red-300';
  if (line.startsWith('@@')) return 'text-cyan-400';
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) return 'text-slate-600';
  return 'text-slate-400';
}

function Activity({ issueId, initial }: { issueId: string; initial: LiveEvent[] }) {
  const [events, setEvents] = useState<LiveEvent[]>(initial);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents(initial);
    const since = initial.length ? initial[initial.length - 1]!.cursor : 0;
    const unsub = streamIssue(issueId, since, (e) =>
      setEvents((prev) => (prev.some((p) => p.cursor === e.cursor) ? prev : [...prev, e])),
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events]);

  return (
    <Panel className="flex h-[calc(100vh-7rem)] flex-col p-0">
      <div className="border-b border-[#262b38] px-4 py-2.5 text-xs font-medium text-slate-400">Activity</div>
      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto p-4">
        {events.length === 0 && <p className="text-xs text-slate-600">No activity yet.</p>}
        {events.map((e) => (
          <div key={e.cursor} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className={`font-mono ${levelColor(e.level)}`}>{e.kind}</span>
              <span className="text-slate-600">{relativeTime(e.created_at)}</span>
            </div>
            <p className="text-slate-400">{e.message}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function levelColor(level: string): string {
  return level === 'error' ? 'text-red-400' : level === 'warn' ? 'text-amber-400' : 'text-indigo-300';
}
