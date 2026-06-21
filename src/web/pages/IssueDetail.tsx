import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, CheckCircle2, CircleSlash, Clock, ExternalLink, FileDiff, GitBranch, GitMerge, MessageSquarePlus, MonitorPlay, Play, Plus, RotateCcw, Sparkles, Square, XCircle } from 'lucide-react';
import type { Attachment, Event, IssueMode, IssueRelation, IssueStatus, IssueType, Priority } from '../../shared/types';
import { api, streamIssue, THINKING_EFFORT_OPTIONS, type ApproveOptions, type IssueDetail as Detail, type ThinkingEffort } from '../api';
import { ApproveDialog } from '../components/ApproveDialog';
import { AttachmentInput } from '../components/AttachmentInput';
import { Markdown } from '../components/Markdown';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Modal, Panel, Select, Spinner, Textarea } from '../components/ui';
import { PRIORITY_META, relativeFuture, relativeTime, STATUS_META } from '../lib/format';

type LiveEvent = Event & { cursor: number };

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: issue, isError, error, refetch } = useQuery({
    queryKey: ['issue', id],
    queryFn: () => api.issues.get(id!),
    refetchInterval: (q) => (isRunning(q.state.data?.status) ? 2000 : false),
  });
  // The orchestrator snapshot is the only authority on whether THIS issue is actually executing a
  // phase vs. merely parked in the retry queue (e.g. behind a global quota suspension) — status
  // alone can't tell them apart, both stay `in_progress`. Poll while the issue isn't terminal.
  const { data: snap } = useQuery({
    queryKey: ['snapshot'],
    queryFn: api.ops.snapshot,
    enabled: !!issue,
    refetchInterval: issue && isRunning(issue.status) ? 2000 : false,
  });

  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <ErrorState
          title="Couldn't load this issue"
          description={error instanceof Error ? error.message : 'It may have been deleted, or the server is unreachable.'}
          onRetry={() => refetch()}
        />
      </div>
    );
  if (!issue) return <Loading />;

  const runningNow = snap ? snap.running.some((r) => r.issue_id === issue.id) : isRunning(issue.status);
  const retry = snap?.retrying.find((r) => r.issue_id === issue.id) ?? null;
  const suspended = snap?.suspended ?? null;
  // "Parked": in_progress on paper but not actually running — queued for retry or stuck behind a
  // global pause. This is exactly the state where the Run button must work as a manual override.
  const parked = isRunning(issue.status) && !runningNow;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-6 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Header issue={issue} runningNow={runningNow} onChange={() => qc.invalidateQueries({ queryKey: ['issue', id] })} />
        {(retry || (suspended && parked)) && <QueueStatusBanner retry={retry} suspended={suspended} />}
        {issue.merge_conflict && <ConflictBanner issue={issue} />}
        {(issue.status === 'review' || issue.status === 'done') && <ReviewPanel issue={issue} />}
        <Revisions issue={issue} />
        <Body issue={issue} onSaved={() => qc.invalidateQueries({ queryKey: ['issue', id] })} />
        <Tasks issue={issue} />
        <Runs issue={issue} />
      </div>
      {/* On lg+ the chain/activity column sticks beside the body; on narrow it stacks below at a
          fixed height so the activity feed stays usable instead of collapsing under flex-1. */}
      <div className="flex flex-col gap-5 lg:sticky lg:top-6 lg:col-span-1 lg:h-[calc(100vh-3rem)]">
        <RelationsPanel issue={issue} />
        <Activity issueId={issue.id} initial={issue.events} />
      </div>
    </div>
  );
}

const isRunning = (s?: IssueStatus) => s === 'in_progress';

/**
 * Shown when an issue looks `in_progress` but is actually parked — queued for retry, and/or held
 * behind a global queue pause (e.g. an agent quota limit). Explains why nothing is moving and that
 * the Run button overrides the pause for this one issue.
 */
function QueueStatusBanner({
  retry,
  suspended,
}: {
  retry: { attempt: number; due_at: number; error: string | null } | null;
  suspended: { until: number; reason: string | null } | null;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-amber-300">
        <Clock className="h-4 w-4 shrink-0" />
        {retry ? (
          <span>
            Queued for retry — attempt {retry.attempt}, due {relativeFuture(retry.due_at)}.
          </span>
        ) : (
          <span>Queue paused until {new Date(suspended!.until).toLocaleString()}.</span>
        )}
      </div>
      {suspended ? (
        <p className="mt-1 text-xs text-muted">
          Orchestrator paused{suspended.reason ? ` — ${suspended.reason}` : ''}. Run dispatches this issue now,
          overriding the pause.
        </p>
      ) : (
        retry?.error && <p className="mt-1 text-xs text-red-400/80">{retry.error}</p>
      )}
    </div>
  );
}

/**
 * SYM-29: shown when an approved review-gate story couldn't be integrated — a local merge conflict
 * (agent branch vs. base) or a diverged-remote push. Explains what failed and offers an agent-backed
 * Resolve-conflict action that re-runs the merge + reconciles the remote. The endpoint is guarded to
 * status==='review' with a marker set; on success the issue is marked done and this banner clears.
 */
function ConflictBanner({ issue }: { issue: Detail }) {
  const qc = useQueryClient();
  const conflict = issue.merge_conflict!;
  const resolve = useMutation({
    mutationFn: () => api.issues.resolveConflict(issue.id),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Conflict resolved — merged into ${r.target_branch ?? 'target branch'} and done`);
      else toast.error(r.reason ?? 'Could not resolve conflict');
    },
    onError: (e) => toast.error(String(e)),
    // Refresh on both success and the 409-into-onError path so the banner/badge reflect the latest
    // marker state (cleared on success, refreshed on a still-failing reconcile).
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['issue', issue.id] });
      qc.invalidateQueries({ queryKey: ['project', issue.project_id] });
    },
  });

  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-red-300">
            <GitMerge className="h-4 w-4 shrink-0" />
            <span className="font-medium">
              Git conflict — {conflict.kind === 'push' ? 'remote base diverged' : 'merge conflict'} on{' '}
              <span className="font-mono">{conflict.target_branch}</span>
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">{conflict.reason}</p>
          {conflict.files && conflict.files.length > 0 && (
            <p className="mt-1 truncate font-mono text-[11px] text-red-400/80" title={conflict.files.join(', ')}>
              {conflict.files.join(', ')}
            </p>
          )}
        </div>
        <Button
          variant="danger"
          className="shrink-0"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate()}
          title="Re-run the merge and reconcile the remote with an agent, then mark done"
        >
          {resolve.isPending ? <Spinner /> : <GitMerge className="h-4 w-4" />} Resolve conflict
        </Button>
      </div>
    </div>
  );
}

function Header({ issue, runningNow, onChange }: { issue: Detail; runningNow: boolean; onChange: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const update = useMutation({
    mutationFn: (patch: Partial<Detail>) => api.issues.update(issue.id, patch),
    onSuccess: onChange,
    onError: (e) => toast.error(String(e)),
  });
  const run = useMutation({
    mutationFn: () => api.issues.run(issue.id),
    onSuccess: (r) => {
      if (!r.ok) return toast.error(r.reason ?? 'Could not run');
      toast.success('Dispatched');
      // Reflect the new running state immediately instead of waiting for the next poll.
      qc.invalidateQueries({ queryKey: ['snapshot'] });
      qc.invalidateQueries({ queryKey: ['issue', issue.id] });
    },
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
    // SYM-29: a 409 throws into onError (not onSuccess), so refresh here too — otherwise the
    // server-persisted git-conflict marker (badge + banner) wouldn't show until the next poll.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['issue', issue.id] });
      qc.invalidateQueries({ queryKey: ['project', issue.project_id] });
    },
  });
  const requestChanges = useMutation({
    mutationFn: (feedback: string) => api.issues.requestChanges(issue.id, { feedback }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Round ${r.round} started${r.dispatched ? '' : ' — queued (no free slots yet)'}`);
        setChangesOpen(false);
        onChange();
      } else {
        toast.error(r.reason ?? 'Could not request changes');
      }
    },
    onError: (e) => toast.error(String(e)),
  });

  const meta = STATUS_META[issue.status];
  const terminal = issue.status === 'done' || issue.status === 'cancelled';
  return (
    <div>
      <Link to={`/projects/${issue.project_id}`} className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" /> Board
      </Link>
      {/* SYM-45: toolbar row (metadata + controls) sits above so the title can own a full line below. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted">{issue.key}</span>
          <span className={`inline-flex items-center gap-1 ${meta.color}`}>
            <span aria-hidden className={`h-2 w-2 rounded-full ${meta.dot}`} /> {meta.label}
          </span>
          <span className={PRIORITY_META[issue.priority].color}>{PRIORITY_META[issue.priority].label}</span>
          {issue.round > 1 && (
            <Badge className="bg-indigo-500/10 text-indigo-300">Round {issue.round}</Badge>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* SYM-47: the auto/manual mode toggle is gone from the detail page — dispatch mode is
              chosen only at creation (Board "New issue" / Follow-up forms); flipping it here had no
              effect given listAutoCandidates' status filter and the always-available Run button. */}
          {/* SYM-46: per-issue extended-thinking override; inherit = the project/engine default.
              SYM-60: hidden on terminal (done/cancelled) issues — thinking_effort is consumed only by
              resolveThinkingEffort in the plan/implement/qa/delivery/merge phases, so the control is a
              no-op once an issue can never re-run. Kept at 'review' (still !terminal) because Request
              changes starts a new round that reads it. */}
          {!terminal && (
            <>
              <Select
                value={issue.thinking_effort ?? ''}
                onChange={(e) => update.mutate({ thinking_effort: (e.target.value || null) as Detail['thinking_effort'] })}
                className="w-auto"
                aria-label="Thinking effort"
                title="Extended-thinking budget for this issue (inherit = project/engine default)"
              >
                <option value="">inherit</option>
                {THINKING_EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
              {/* SYM-67: per-issue Workflow-tool override; inherit = the project/engine default. Same
                  !terminal gate as thinking_effort — it's only consumed by the build phases. */}
              <Select
                value={issue.enable_workflow_tool === null ? '' : String(issue.enable_workflow_tool)}
                onChange={(e) =>
                  update.mutate({ enable_workflow_tool: e.target.value === '' ? null : e.target.value === 'true' })
                }
                className="w-auto"
                aria-label="Workflow tool"
                title="Workflow tool for this issue (inherit = project/engine default; on lets the agent self-spawn background runs)"
              >
                <option value="">workflow: inherit</option>
                <option value="false">workflow: off</option>
                <option value="true">workflow: on</option>
              </Select>
            </>
          )}
          {issue.status === 'review' ? (
            <>
              <Button
                variant="subtle"
                disabled={requestChanges.isPending}
                onClick={() => setChangesOpen(true)}
                title="Start another round: write feedback and re-run plan → implement → QA on the same branch"
              >
                {requestChanges.isPending ? <Spinner /> : <MessageSquarePlus className="h-4 w-4" />} Request changes
              </Button>
              <Button variant="primary" disabled={approve.isPending} onClick={() => setApproveOpen(true)} title={`Merge ${issue.branch_name} and mark done`}>
                {approve.isPending ? <Spinner /> : <Check className="h-4 w-4" />} Approve & merge
              </Button>
            </>
          ) : !terminal ? (
            <Button variant="primary" disabled={runningNow || run.isPending} onClick={() => run.mutate()}>
              {runningNow || run.isPending ? <Spinner /> : <Play className="h-4 w-4" />} Run
            </Button>
          ) : issue.status === 'done' ? (
            <Button variant="primary" onClick={() => setFollowUpOpen((v) => !v)}>
              <Plus className="h-4 w-4" /> Follow-up
            </Button>
          ) : null}
          {issue.status !== 'cancelled' && issue.status !== 'done' && (
            <Button variant="ghost" aria-label="Cancel issue" title="Cancel" onClick={() => update.mutate({ status: 'cancelled' })}>
              <CircleSlash className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <h1 className="mt-2 text-xl font-semibold leading-tight break-words">{issue.title}</h1>
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
      {changesOpen && (
        <RequestChangesDialog
          issue={issue}
          pending={requestChanges.isPending}
          onCancel={() => setChangesOpen(false)}
          onConfirm={(feedback) => requestChanges.mutate(feedback)}
        />
      )}
      {followUpOpen && (
        <FollowUpForm
          source={issue}
          onCancel={() => setFollowUpOpen(false)}
          onCreated={(newIssueId) => {
            setFollowUpOpen(false);
            qc.invalidateQueries({ queryKey: ['issue', issue.id] });
            qc.invalidateQueries({ queryKey: ['project', issue.project_id] });
            navigate(`/issues/${newIssueId}`);
          }}
        />
      )}
    </div>
  );
}

function FollowUpForm({
  source,
  onCancel,
  onCreated,
}: {
  source: Detail;
  onCancel: () => void;
  onCreated: (issueId: string) => void;
}) {
  const [form, setForm] = useState<{
    title: string;
    type: IssueType;
    priority: Priority;
    mode: IssueMode;
    status: Extract<IssueStatus, 'backlog' | 'todo'>;
    thinking_effort: '' | ThinkingEffort;
    enable_workflow_tool: '' | 'true' | 'false';
    description: string;
    acceptance_criteria: string;
    include_context: boolean;
  }>({
    title: '',
    type: source.type,
    priority: source.priority,
    mode: 'manual',
    status: 'todo',
    thinking_effort: '', // SYM-46: '' = inherit the project/engine default
    enable_workflow_tool: '', // SYM-67: '' = inherit, 'false' = off, 'true' = on
    description: '',
    acceptance_criteria: '',
    include_context: true,
  });
  const create = useMutation({
    mutationFn: () =>
      api.issues.createFollowUp(source.id, {
        title: form.title,
        type: form.type as Detail['type'],
        priority: form.priority as Detail['priority'],
        mode: form.mode as Detail['mode'],
        status: form.status as IssueStatus,
        thinking_effort: form.thinking_effort || null,
        enable_workflow_tool:
          form.enable_workflow_tool === '' ? null : form.enable_workflow_tool === 'true',
        description: form.description || null,
        acceptance_criteria: form.acceptance_criteria || null,
        include_context: form.include_context,
      }),
    onSuccess: (result) => {
      toast.success('Follow-up story created');
      onCreated(result.issue.id);
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <Panel className="mt-4 p-4">
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted">
            <GitBranch className="h-3.5 w-3.5" />
            <span className="font-mono">{source.key}</span>
            <span className="truncate">{source.title}</span>
          </div>
          <Field label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What needs to change next?" autoFocus />
          </Field>
        </div>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as IssueType })}>
            <option value="feature">feature</option>
            <option value="bug">bug</option>
            <option value="chore">chore</option>
            <option value="epic">epic</option>
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) as Priority })}>
            <option value={1}>Urgent</option>
            <option value={2}>High</option>
            <option value={3}>Medium</option>
            <option value={4}>Low</option>
            <option value={0}>None</option>
          </Select>
        </Field>
        <Field label="Mode">
          <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as IssueMode })}>
            <option value="manual">manual</option>
            <option value="auto">auto</option>
          </Select>
        </Field>
        <Field label="Initial status">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Extract<IssueStatus, 'backlog' | 'todo'> })}>
            <option value="backlog">backlog</option>
            <option value="todo">todo</option>
          </Select>
        </Field>
        {/* SYM-46: carry a per-issue extended-thinking override onto the follow-up; inherit = default. */}
        <Field label="Thinking effort">
          <Select value={form.thinking_effort} onChange={(e) => setForm({ ...form, thinking_effort: e.target.value as '' | ThinkingEffort })}>
            <option value="">inherit (project default)</option>
            {THINKING_EFFORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </Field>
        {/* SYM-67: carry a per-issue Workflow-tool override onto the follow-up; inherit = default. */}
        <Field label="Workflow tool">
          <Select value={form.enable_workflow_tool} onChange={(e) => setForm({ ...form, enable_workflow_tool: e.target.value as '' | 'true' | 'false' })}>
            <option value="">inherit (project default)</option>
            <option value="false">off</option>
            <option value="true">on (advanced)</option>
          </Select>
        </Field>
        <div className="col-span-2">
          <Field label="Description">
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Acceptance criteria">
            <Textarea rows={3} value={form.acceptance_criteria} onChange={(e) => setForm({ ...form, acceptance_criteria: e.target.value })} placeholder="- ..." />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={form.include_context}
            onChange={(e) => setForm({ ...form, include_context: e.target.checked })}
            className="h-4 w-4 rounded border-border bg-bg-2"
          />
          Reference context
        </label>
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!form.title || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} Create follow-up
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function RequestChangesDialog({
  issue,
  pending,
  onCancel,
  onConfirm,
}: {
  issue: Detail;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState('');
  const trimmed = feedback.trim();
  const nextRound = issue.round + 1;
  const close = () => {
    if (!pending) onCancel();
  };
  return (
    <Modal
      onClose={close}
      icon={<MessageSquarePlus className="h-4 w-4 text-indigo-300" />}
      title={`Request changes · round ${nextRound}`}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!trimmed || pending} onClick={() => onConfirm(trimmed)}>
            {pending ? <Spinner /> : <RotateCcw className="h-4 w-4" />} Start round {nextRound}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">
        Not happy with this round? Describe what to fix. The agent re-plans, re-implements, and
        re-QAs on the <span className="font-mono">{issue.branch_name}</span> branch — building on
        what's already there, with your feedback as the top priority.
      </p>
      <Field label="What needs to change?">
        <Textarea
          rows={5}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. Close the dialog on Escape, and tighten the empty-state copy."
          autoFocus
        />
      </Field>
    </Modal>
  );
}

function Revisions({ issue }: { issue: Detail }) {
  if (issue.revisions.length === 0) return null;
  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
        <MessageSquarePlus className="h-3.5 w-3.5" /> Revision history ({issue.revisions.length})
      </div>
      <ol className="space-y-2">
        {issue.revisions.map((r) => (
          <li key={r.id} className="rounded-md border border-border bg-bg-2 px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px]">
              <Badge className="bg-indigo-500/10 text-indigo-300">Round {r.round}</Badge>
              <span className="text-subtle">{relativeTime(r.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-fg">{r.feedback}</p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function RelationsPanel({ issue }: { issue: Detail }) {
  const incoming = issue.relations.incoming;
  const outgoing = issue.relations.outgoing;
  if (incoming.length === 0 && outgoing.length === 0) return null;

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
        <GitBranch className="h-3.5 w-3.5" /> Story chain
      </div>
      {incoming.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase text-muted">Predecessors</p>
          {incoming.map((relation) => (
            <RelationRow key={relation.id} relation={relation} side="source" />
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className={incoming.length > 0 ? 'mt-4 space-y-2' : 'space-y-2'}>
          <p className="text-[11px] font-medium uppercase text-muted">Follow-ups</p>
          {outgoing.map((relation) => (
            <RelationRow key={relation.id} relation={relation} side="target" />
          ))}
        </div>
      )}
    </Panel>
  );
}

function RelationRow({ relation, side }: { relation: IssueRelation; side: 'source' | 'target' }) {
  const linked = side === 'source' ? relation.source : relation.target;
  const meta = STATUS_META[linked.status];
  return (
    <div className="rounded-md border border-border bg-bg-2 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/issues/${linked.id}`} className="min-w-0 hover:text-indigo-300">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-muted">{linked.key}</span>
            <span className={`inline-flex items-center gap-1 ${meta.color}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} /> {meta.label}
            </span>
            <Badge className="bg-indigo-500/10 text-indigo-300">{relation.type === 'follow_up' ? 'follow-up' : 'related'}</Badge>
          </div>
          <p className="mt-1 truncate text-sm text-fg">{linked.title}</p>
        </Link>
      </div>
      {relation.context_summary && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted hover:text-fg">Referenced context</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 font-mono text-[11px] leading-relaxed text-muted">
            {relation.context_summary}
          </pre>
        </details>
      )}
    </div>
  );
}

function Body({ issue, onSaved }: { issue: Detail; onSaved: () => void }) {
  const [desc, setDesc] = useState(issue.description ?? '');
  const [ac, setAc] = useState(issue.acceptance_criteria ?? '');
  // SYM-35: uploads here pre-link to the issue (issueId set) and removals delete immediately, so
  // attachments persist without the Save button. Seed once from the detail; this panel owns them after.
  const [attachments, setAttachments] = useState<Attachment[]>(issue.attachments ?? []);
  const dirty = desc !== (issue.description ?? '') || ac !== (issue.acceptance_criteria ?? '');
  const save = useMutation({
    mutationFn: () => api.issues.update(issue.id, { description: desc, acceptance_criteria: ac }),
    onSuccess: () => { onSaved(); toast.success('Saved'); },
  });

  return (
    <Panel className="space-y-4 p-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Description</p>
        <Textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Acceptance criteria</p>
        <Textarea rows={4} value={ac} onChange={(e) => setAc(e.target.value)} />
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Attachments</p>
        <AttachmentInput
          projectId={issue.project_id}
          issueId={issue.id}
          value={attachments}
          onChange={(next) => {
            setAttachments(next);
            onSaved(); // refresh the detail so the agent prompt / other consumers see the change
          }}
        />
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
      <p className="mb-3 text-xs font-medium text-muted">Plan ({issue.tasks.length} tasks)</p>
      <ul className="space-y-1.5">
        {issue.tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm">
            <span className={`h-3.5 w-3.5 rounded-sm border ${t.status === 'done' ? 'border-emerald-500 bg-emerald-500/30' : t.status === 'failed' ? 'border-red-500 bg-red-500/20' : t.status === 'running' ? 'border-amber-400' : 'border-slate-600'}`} />
            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">{t.role}</span>
            <span className={t.status === 'done' ? 'text-muted line-through' : 'text-fg'}>{t.title}</span>
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
      <p className="mb-3 text-xs font-medium text-muted">Runs</p>
      <div className="space-y-1.5">
        {issue.runs.map((r) => (
          <div key={r.id} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-20 font-mono text-muted">{r.phase}</span>
              <Badge className={r.status === 'succeeded' ? 'bg-emerald-500/15 text-emerald-300' : r.status === 'running' ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300'}>
                {r.status}
              </Badge>
              {r.round > 1 && <span className="text-indigo-300" title={`Revision round ${r.round}`}>r{r.round}</span>}
              <span className="text-subtle">att {r.attempt}</span>
            </div>
            <span className="text-subtle">{r.total_tokens.toLocaleString()} tok · {r.num_turns} turns</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ReviewPanel({ issue }: { issue: Detail }) {
  // ── delivery summary (§SYM-22): the user-facing wrap-up, shown above the QA box ──
  // listRuns is newest-first, so .find lands on the latest round's delivery report.
  const deliveryReport = issue.runs.find((r) => r.phase === 'delivery')?.report?.trim();

  // ── QA verdict + evidence (item 2), derived from existing runs/events ──
  const qaRun = issue.runs.find((r) => r.phase === 'qa');
  const pass = qaRun?.status === 'succeeded';
  const phaseOf = (e: LiveEvent) => (e.data as { phase?: string } | null)?.phase;
  const verdict = issue.events.find((e) => e.kind === 'phase.end' && phaseOf(e) === 'qa')?.message;
  const qaActivity = issue.events.filter((e) => phaseOf(e) === 'qa' && e.kind === 'agent.tool');

  // ── diff (item 1) ──
  // isError/error/refetch are load-bearing: on a failed fetch `diff` is undefined, so without an
  // explicit error branch the render falls through to `!diff?.available` and mislabels the failure
  // as "No diff" (SYM-71). Surface a real error state with retry instead.
  const { data: diff, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['diff', issue.id],
    queryFn: () => api.issues.diff(issue.id),
  });

  return (
    <Panel className="p-4">
      {/* Delivery summary — the friendly wrap-up, sits above the QA evidence box (§SYM-22) */}
      {deliveryReport && (
        <section className="mb-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
            <Sparkles className="h-3.5 w-3.5 text-indigo-300" /> Delivery summary
          </div>
          <div className="rounded-md border border-indigo-500/20 bg-indigo-500/[0.06] p-3">
            <Markdown source={deliveryReport} />
          </div>
        </section>
      )}

      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
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
            <span className="text-muted"> — {(verdict ?? '').replace(/^QA (PASS|FAIL)\s*[—-]?\s*/i, '') || 'self-QA verdict'}</span>
          </div>
        </div>
      )}

      {/* What the QA agent ran (evidence the checks actually executed) */}
      {qaActivity.length > 0 && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
            QA ran {qaActivity.length} step(s)
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-2">
            {qaActivity.slice(0, 12).map((e) => (
              <li key={e.cursor} className="truncate font-mono text-[11px] text-muted">
                {e.message.replace(/^qa:\s*/, '')}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Live preview (only while the worktree still exists, i.e. before approval) */}
      {issue.status === 'review' && <Preview issueId={issue.id} />}

      {/* Diff — order is load-bearing: loading → error → empty → success. The error branch MUST
          precede `!diff?.available`, because on a failed fetch `diff` is undefined and the empty
          check would otherwise swallow the failure as "No diff" (SYM-71). */}
      <div className="text-xs">
        {isLoading ? (
          <span className="text-subtle">Loading diff…</span>
        ) : isError ? (
          <ErrorState
            title="Couldn't load the diff"
            description={error instanceof Error ? error.message : 'The server is unreachable or returned an error.'}
            onRetry={() => refetch()}
          />
        ) : !diff?.available ? (
          <span className="text-subtle">No diff (no committed changes on the agent branch).</span>
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
    <div className="mb-3 rounded-md border border-border bg-bg-2 p-2.5 text-xs">
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
          <p className="mt-1 font-mono text-[10px] text-subtle">{status.command}</p>
          {status.output && (
            <pre className="mt-1.5 max-h-28 overflow-auto rounded bg-bg p-2 font-mono text-[10px] text-muted">
              {status.output.slice(-1500)}
            </pre>
          )}
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Launch the project from this worktree to click through it.</span>
            <Button variant="subtle" className="px-2 py-1" disabled={start.isPending} onClick={() => start.mutate()}>
              <MonitorPlay className="h-3.5 w-3.5" /> Preview
            </Button>
          </div>
          {status?.error && (
            <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 font-mono text-[10px] text-red-300">
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
        <span className="text-muted">
          {diff.files.length} file(s) changed on <span className="font-mono text-muted">{diff.branch}</span>
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
            <span className="truncate text-fg">{f.path}</span>
          </li>
        ))}
      </ul>
      {open && (
        <pre className="max-h-96 overflow-auto rounded-md bg-bg p-3 font-mono text-[11px] leading-relaxed">
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
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) return 'text-subtle';
  return 'text-muted';
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
    <Panel className="flex min-h-0 flex-1 flex-col p-0 max-lg:h-[420px]">
      <div className="border-b border-border px-4 py-2.5 text-xs font-medium text-muted">Activity</div>
      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto p-4">
        {events.length === 0 && <EmptyState compact title="No activity yet." className="text-xs" />}
        {events.map((e) => (
          <div key={e.cursor} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className={`font-mono ${levelColor(e.level)}`}>{e.kind}</span>
              <span className="text-subtle">{relativeTime(e.created_at)}</span>
            </div>
            <p className="text-muted">{e.message}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function levelColor(level: string): string {
  return level === 'error' ? 'text-red-400' : level === 'warn' ? 'text-amber-400' : 'text-indigo-300';
}
