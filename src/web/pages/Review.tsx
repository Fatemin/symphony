import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ChevronDown,
  EyeOff,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  AgentType,
  ReviewFinding,
  ReviewRunWithFindings,
  ReviewScope,
} from '../../shared/types';
import { REVIEW_SCOPES } from '../../shared/types';
import { AGENT_OPTIONS } from '../../shared/models';
import { api } from '../api';
import { ProjectTabs } from '../components/ProjectTabs';
import { Markdown } from '../components/Markdown';
import { Button, EmptyState, ErrorState, Loading, Modal, PageHeader, Panel, ProjectChip, Select, Spinner } from '../components/ui';
import {
  REVIEW_CATEGORY_META,
  REVIEW_SCOPE_META,
  REVIEW_SEVERITY_META,
  REVIEW_SEVERITY_ORDER,
  REVIEW_STATUS_META,
  relativeTime,
} from '../lib/format';

// SYM-51: the Review tab runs a standalone, read-only agent audit of the project (docs / code /
// ui_ux / all) and surfaces its graded findings as draft "issue cards" the user can convert into
// real issues or dismiss. The run is async and one-at-a-time per project, so the page polls while a
// batch is in flight to flip it running → completed without a manual refresh.

export function Review() {
  const { id } = useParams<{ id: string }>();
  const projectId = id!;
  const qc = useQueryClient();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId),
  });

  const {
    data: runs,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['project-reviews', projectId],
    queryFn: () => api.projects.reviews(projectId),
    enabled: !!project?.repo_path,
    // Reviews complete in the background — poll only while a batch is still running, then idle.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 3000 : false,
  });

  const [scope, setScope] = useState<ReviewScope>('all');
  // '' = inherit the project's configured agent (the server resolves req ?? WORKFLOW ?? project ?? engine).
  const [agent, setAgent] = useState<AgentType | ''>('');

  const runningRun = runs?.find((r) => r.status === 'running') ?? null;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['project-reviews', projectId] });

  const start = useMutation({
    mutationFn: () => api.projects.startReview(projectId, { scope, agent: agent || undefined }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(String(e)),
  });

  const convert = useMutation({
    mutationFn: (vars: { findingId: string; status: 'todo' | 'backlog' }) =>
      api.projects.convertFinding(projectId, vars.findingId, { status: vars.status }),
    onSuccess: ({ issue }) => {
      toast.success(`Created ${issue.key} — ${issue.title}`);
      invalidate();
      qc.invalidateQueries({ queryKey: ['project', projectId] }); // the new issue shows on the Board
    },
    onError: (e) => toast.error(String(e)),
  });

  const setStatus = useMutation({
    mutationFn: (vars: { findingId: string; dismissed: boolean }) =>
      vars.dismissed
        ? api.projects.dismissFinding(projectId, vars.findingId)
        : api.projects.restoreFinding(projectId, vars.findingId),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(String(e)),
  });

  const removeRun = useMutation({
    mutationFn: (runId: string) => api.projects.deleteReview(projectId, runId),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(String(e)),
  });

  // SYM-66: one-click batch convert — every still-draft finding of a run becomes an `auto` issue the
  // orchestrator starts working through (most critical first). Idempotent server-side, so re-clicking
  // is safe. Refresh both the reviews list (cards flip to "Created KEY") and the board (new issues).
  const batchConvert = useMutation({
    mutationFn: (runId: string) =>
      api.projects.convertAllFindings(projectId, runId, { mode: 'auto', status: 'todo' }),
    onSuccess: ({ converted }) => {
      toast.success(
        converted === 0
          ? 'Nothing left to convert — every finding was already handled.'
          : `Created ${converted} auto ${converted === 1 ? 'issue' : 'issues'} — the orchestrator is on it.`,
      );
      invalidate();
      qc.invalidateQueries({ queryKey: ['project', projectId] }); // the new issues show on the Board
    },
    onError: (e) => toast.error(String(e)),
  });

  const busy = convert.isPending || setStatus.isPending || batchConvert.isPending;

  if (!project) return <Loading />;

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        back={{ to: '/' }}
        icon={<ProjectChip color={project.color}>{project.key}</ProjectChip>}
        title={project.name}
      />

      <ProjectTabs projectId={project.id} />

      {!project.repo_path ? (
        <NoRepo />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 pb-12">
            <RunControl
              scope={scope}
              onScope={setScope}
              agent={agent}
              onAgent={setAgent}
              running={!!runningRun}
              starting={start.isPending}
              onRun={() => start.mutate()}
            />

            {isLoading ? (
              <Loading label="Loading reviews…" />
            ) : isError ? (
              <ErrorState
                title="Couldn't load reviews"
                description={error instanceof Error ? error.message : undefined}
                onRetry={invalidate}
              />
            ) : !runs || runs.length === 0 ? (
              <EmptyReviews />
            ) : (
              <div className="space-y-4">
                {runs.map((run) => (
                  <ReviewBatch
                    key={run.id}
                    run={run}
                    busy={busy}
                    onConvert={(findingId, status) => convert.mutate({ findingId, status })}
                    onDismiss={(findingId) => setStatus.mutate({ findingId, dismissed: true })}
                    onRestore={(findingId) => setStatus.mutate({ findingId, dismissed: false })}
                    onDelete={() => removeRun.mutate(run.id)}
                    deleting={removeRun.isPending && removeRun.variables === run.id}
                    onBatchConvert={() => batchConvert.mutate(run.id)}
                    batchConverting={batchConvert.isPending && batchConvert.variables === run.id}
                    // Block the mass action while any conversion is in flight or a review is still
                    // running — keeps the board state settled before a one-click auto dispatch.
                    batchDisabled={busy || !!runningRun}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunControl({
  scope,
  onScope,
  agent,
  onAgent,
  running,
  starting,
  onRun,
}: {
  scope: ReviewScope;
  onScope: (s: ReviewScope) => void;
  agent: AgentType | '';
  onAgent: (a: AgentType | '') => void;
  running: boolean;
  starting: boolean;
  onRun: () => void;
}) {
  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
        <ScanSearch className="h-4 w-4 text-indigo-300" />
        Run a review
      </div>
      <p className="mb-3 text-xs text-muted">
        A read-only agent inspects this project and reports graded findings you can turn into issues.
      </p>

      <div role="group" aria-label="Review scope" className="mb-2 flex flex-wrap gap-1.5">
        {REVIEW_SCOPES.map((s) => {
          const active = s === scope;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              onClick={() => onScope(s)}
              className={`rounded-md border px-3 py-1.5 text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                active
                  ? 'border-indigo-400 bg-indigo-500/15 text-fg'
                  : 'border-border text-muted hover:bg-panel-2 hover:text-fg'
              }`}
            >
              {REVIEW_SCOPE_META[s].label}
            </button>
          );
        })}
      </div>
      <p className="mb-3 text-xs text-muted">{REVIEW_SCOPE_META[scope].hint}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Agent"
          className="w-auto py-1.5 text-xs"
          value={agent}
          onChange={(e) => onAgent(e.target.value as AgentType | '')}
        >
          <option value="">default agent</option>
          {AGENT_OPTIONS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </Select>
        <Button variant="primary" disabled={running || starting} onClick={onRun}>
          {starting ? <Spinner /> : <ScanSearch className="h-4 w-4" />}
          {running ? 'Review running…' : 'Run review'}
        </Button>
        {running && (
          <span className="text-xs text-muted">
            One review runs at a time per project — it finishes in the background.
          </span>
        )}
      </div>
    </Panel>
  );
}

function ReviewBatch({
  run,
  busy,
  onConvert,
  onDismiss,
  onRestore,
  onDelete,
  deleting,
  onBatchConvert,
  batchConverting,
  batchDisabled,
}: {
  run: ReviewRunWithFindings;
  busy: boolean;
  onConvert: (findingId: string, status: 'todo' | 'backlog') => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  onDelete: () => void;
  deleting: boolean;
  onBatchConvert: () => void;
  batchConverting: boolean;
  batchDisabled: boolean;
}) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // SYM-69: deleting a batch destroys the run and every finding it produced (irreversible), so the
  // trash icon routes through this confirm dialog instead of firing the mutation directly.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const status = REVIEW_STATUS_META[run.status];
  const active = run.findings.filter((f) => f.status !== 'dismissed');
  const dismissed = run.findings.filter((f) => f.status === 'dismissed');
  const drafts = active.filter((f) => f.status === 'draft');
  const groups = groupBySeverity(active);

  // Auto-close the confirm dialog once the mutation settles (success or error) — the toast carries the
  // outcome, so the modal need not linger. Tracks the pending edge instead of closing on click so the
  // confirm button's spinner stays visible during the request.
  const wasConverting = useRef(false);
  useEffect(() => {
    if (wasConverting.current && !batchConverting) setConfirmOpen(false);
    wasConverting.current = batchConverting;
  }, [batchConverting]);

  // Same pending-edge close for delete. On success the parent's refetch drops this run and the whole
  // batch unmounts, so this effect specifically covers the error path: the run stays, the toast carries
  // the failure, and the modal should fall away rather than stranding a stale confirmation.
  const wasDeleting = useRef(false);
  useEffect(() => {
    if (wasDeleting.current && !deleting) setConfirmDeleteOpen(false);
    wasDeleting.current = deleting;
  }, [deleting]);

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium text-fg">{REVIEW_SCOPE_META[run.scope].label}</span>
          <span className={`inline-flex items-center gap-1.5 text-xs ${status.color}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
          {run.agent && <span className="text-xs text-muted">{run.agent}</span>}
          <span className="text-xs text-muted">{relativeTime(run.created_at)}</span>
          {run.status === 'completed' && (
            <span className="text-xs text-muted">
              {active.length} {active.length === 1 ? 'finding' : 'findings'}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Delete this review"
          title="Delete this review"
          onClick={() => setConfirmDeleteOpen(true)}
          disabled={deleting}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition hover:bg-hover hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
        >
          {deleting ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="p-4">
        {run.status === 'running' ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Reviewing… this runs in the background, so you can leave this page.
          </div>
        ) : run.status === 'failed' ? (
          <div className="flex items-start gap-2 text-sm text-red-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{run.error || 'The review failed.'}</span>
          </div>
        ) : (
          <div className="space-y-4">
            {run.summary && (
              <div className="rounded-md border border-border bg-bg-2 px-3 py-2 text-sm leading-relaxed text-muted">
                <Markdown source={run.summary} />
              </div>
            )}

            {drafts.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-accent)]/30 bg-indigo-500/5 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
                  <span>
                    {drafts.length} {drafts.length === 1 ? 'draft is' : 'drafts are'} ready — hand the
                    whole batch to the orchestrator in one click.
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={batchDisabled}
                  onClick={() => setConfirmOpen(true)}
                >
                  {batchConverting ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                  Create all as auto {drafts.length === 1 ? 'issue' : 'issues'} ({drafts.length})
                </Button>
              </div>
            )}

            {active.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                No issues found — this scope looks healthy.
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.severity} className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${REVIEW_SEVERITY_META[group.severity].dot}`}
                    />
                    {REVIEW_SEVERITY_META[group.severity].label} · {group.findings.length}
                  </div>
                  {group.findings.map((f) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      showCategory={run.scope === 'all'}
                      busy={busy}
                      onConvert={(s) => onConvert(f.id, s)}
                      onDismiss={() => onDismiss(f.id)}
                    />
                  ))}
                </div>
              ))
            )}

            {dismissed.length > 0 && (
              <div>
                <button
                  type="button"
                  aria-expanded={showDismissed}
                  onClick={() => setShowDismissed((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-fg"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${showDismissed ? '' : '-rotate-90'}`}
                  />
                  Dismissed ({dismissed.length})
                </button>
                {showDismissed && (
                  <div className="mt-2 space-y-1.5">
                    {dismissed.map((f) => (
                      <div
                        key={f.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-2 px-3 py-1.5 text-sm"
                      >
                        <span className="truncate text-muted line-through">{f.title}</span>
                        <button
                          type="button"
                          onClick={() => onRestore(f.id)}
                          disabled={busy}
                          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted transition hover:text-fg disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" /> Restore
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {confirmOpen && (
        <Modal
          size="sm"
          onClose={() => {
            if (!batchConverting) setConfirmOpen(false);
          }}
          icon={<Sparkles className="h-4 w-4 text-indigo-300" />}
          title={`Create ${drafts.length} auto ${drafts.length === 1 ? 'issue' : 'issues'}?`}
          footer={
            <>
              <Button onClick={() => setConfirmOpen(false)} disabled={batchConverting}>
                Cancel
              </Button>
              <Button variant="primary" disabled={batchConverting} onClick={onBatchConvert}>
                {batchConverting ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                Create {drafts.length} {drafts.length === 1 ? 'issue' : 'issues'}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Each remaining draft becomes an <span className="font-medium text-fg">auto issue</span> the
            orchestrator starts working through automatically — most critical first. Already-converted
            or dismissed findings are left untouched.
          </p>
          <ul className="space-y-1">
            {REVIEW_SEVERITY_ORDER.map((severity) => {
              const count = drafts.filter((f) => f.severity === severity).length;
              if (count === 0) return null;
              return (
                <li key={severity} className="flex items-center gap-2 text-xs text-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${REVIEW_SEVERITY_META[severity].dot}`} />
                  {count} {REVIEW_SEVERITY_META[severity].label.toLowerCase()}
                </li>
              );
            })}
          </ul>
        </Modal>
      )}

      {confirmDeleteOpen && (
        <Modal
          size="sm"
          onClose={() => {
            if (!deleting) setConfirmDeleteOpen(false);
          }}
          icon={<AlertTriangle className="h-4 w-4 text-red-400" />}
          title="Delete this review?"
          footer={
            <>
              <Button onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" disabled={deleting} onClick={onDelete}>
                {deleting ? <Spinner /> : <Trash2 className="h-4 w-4" />}
                Delete review
              </Button>
            </>
          }
        >
          {run.findings.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted">
              This {REVIEW_SCOPE_META[run.scope].label} batch has no findings yet — it will be
              removed.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              This permanently deletes this {REVIEW_SCOPE_META[run.scope].label} batch and its{' '}
              {run.findings.length} {run.findings.length === 1 ? 'finding' : 'findings'}. This can't
              be undone.
              {drafts.length > 0 && (
                <>
                  {' '}
                  <span className="font-medium text-fg">
                    {drafts.length} graded {drafts.length === 1 ? 'finding' : 'findings'} you haven't
                    converted yet
                  </span>{' '}
                  will be lost.
                </>
              )}
            </p>
          )}
        </Modal>
      )}
    </Panel>
  );
}

// SYM-61: the finding renders as a scannable "issue card". Severity is owned by the labeled group
// header above; the card reinforces it with a quiet left grade-rail (never color-alone) and otherwise
// optimises for a fast read: one header line (type icon + title + optional area chip), the description
// as themed Markdown, the long acceptance-criteria checklist behind a progressive-disclosure toggle,
// and a single primary CTA in a flex-wrapping footer (secondary + dismiss subordinate).
function FindingCard({
  finding,
  showCategory,
  busy,
  onConvert,
  onDismiss,
}: {
  finding: ReviewFinding;
  showCategory: boolean;
  busy: boolean;
  onConvert: (status: 'todo' | 'backlog') => void;
  onDismiss: () => void;
}) {
  const [showCriteria, setShowCriteria] = useState(false);
  const severity = REVIEW_SEVERITY_META[finding.severity];
  const Icon = finding.type === 'bug' ? Bug : Sparkles;
  const converted = finding.status === 'converted';
  // Converted cards de-emphasise (a decision was made) and swap the grade rail for a success tint so
  // the eye lands on findings still awaiting a call.
  const rail = converted ? 'border-l-emerald-500/60' : severity.rail;

  return (
    <div
      className={`rounded-lg border border-l-2 border-border bg-bg-2 p-3 transition-colors hover:border-[var(--color-accent)]/60 ${rail} ${converted ? 'opacity-90' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span role="img" aria-label={finding.type} title={finding.type} className="mt-0.5 shrink-0">
          <Icon className="h-4 w-4 text-muted" />
        </span>
        <div className="min-w-0 flex-1 text-sm font-medium text-fg">{finding.title}</div>
        {showCategory && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${REVIEW_CATEGORY_META[finding.category].badge}`}
          >
            {REVIEW_CATEGORY_META[finding.category].label}
          </span>
        )}
      </div>

      {finding.description && (
        <div className="mt-1.5 text-xs text-muted">
          <Markdown source={finding.description} />
        </div>
      )}

      {finding.acceptance_criteria && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={showCriteria}
            onClick={() => setShowCriteria((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-fg"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${showCriteria ? '' : '-rotate-90'}`}
            />
            Acceptance criteria
          </button>
          {showCriteria && (
            <div className="mt-2 rounded-md border border-border bg-bg-2 px-3 py-2 text-xs">
              <Markdown source={finding.acceptance_criteria} />
            </div>
          )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {converted ? (
          <Link
            to={`/issues/${finding.issue_id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:underline"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Created {finding.issue_key ?? 'issue'}
          </Link>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onConvert('todo')}>
              Create issue
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onConvert('backlog')}>
              Backlog
            </Button>
            <button
              type="button"
              aria-label="Dismiss finding"
              title="Dismiss"
              onClick={onDismiss}
              disabled={busy}
              className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function EmptyReviews() {
  return (
    <EmptyState
      icon={<ScanSearch />}
      title="No reviews yet"
      description="Pick a scope above and run one — findings show up here graded by severity, ready to convert into issues."
    />
  );
}

function NoRepo() {
  return (
    <div className="mx-auto mt-10 w-full max-w-md">
      <EmptyState
        icon={<ScanSearch />}
        title="No linked repo"
        description="This project has no linked repo, so there is nothing to review. Link a repository in the Agent settings first."
      />
    </div>
  );
}

interface SeverityGroup {
  severity: ReviewFinding['severity'];
  findings: ReviewFinding[];
}

/** Group active findings by severity (most important first), stable on seq within each grade. */
function groupBySeverity(findings: ReviewFinding[]): SeverityGroup[] {
  return REVIEW_SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings
      .filter((f) => f.severity === severity)
      .sort((a, b) => a.seq - b.seq),
  })).filter((g) => g.findings.length > 0);
}
