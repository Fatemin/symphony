import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Check, CheckSquare, ChevronDown, ChevronRight, FilePlus2, GitMerge, Maximize2, Minimize2, Plus, Sparkles, Square } from 'lucide-react';
import type { Attachment, BoardIssue, Issue, IssueStatus } from '../../shared/types';
import { api, THINKING_EFFORT_OPTIONS, type ApproveOptions } from '../api';
import { ApproveDialog } from '../components/ApproveDialog';
import { AskPanel } from '../components/AskPanel';
import { AttachmentInput } from '../components/AttachmentInput';
import { ProjectTabs } from '../components/ProjectTabs';
import { Badge, Button, Field, Input, Loading, Modal, PageHeader, Panel, ProjectChip, Select, Textarea } from '../components/ui';
import { PHASE_META, PRIORITY_META, STATUS_META } from '../lib/format';

const COLUMNS: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

// SYM-23: collapsed board columns persist globally (same 5 statuses on every project board), mirroring
// the sidebar's global expanded-projects key. We store the *collapsed* statuses so the default empty
// set means all columns expanded.
const COLLAPSED_KEY = 'symphony.board.collapsedColumns';

export function Board() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id!),
    refetchInterval: 3000,
  });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approveOpen, setApproveOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  // SYM-23: which status columns are collapsed (seeded from localStorage). Mirrors Layout.tsx's
  // expanded-projects pattern: write-back effect + toggle mutator, all localStorage wrapped in try/catch.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<IssueStatus>>(() => readCollapsed());
  // SYM-26 (issue 1): the collapsed set captured when focus mode is first entered, so restoring
  // returns to exactly the pre-focus state instead of expanding every column. null = not in focus
  // mode. Transient/in-memory only (not persisted) — a reload while focused falls back to
  // all-expanded on restore, which is an acceptable edge case.
  const [focusSnapshot, setFocusSnapshot] = useState<Set<IssueStatus> | null>(null);
  // SYM-13: track which cards just changed status so we can play the lift-drop animation. The board
  // polls every 3s and each poll yields a fresh issues array, so the diff effect below runs often —
  // it stays a no-op unless a status actually changed. `prevStatus` seeds on the first load without
  // flagging anything, so cards only animate on a *transition*, not on initial render.
  const prevStatus = useRef<Map<string, IssueStatus>>(new Map());
  const [moved, setMoved] = useState<Set<string>>(new Set());

  const byStatus = (status: IssueStatus) => (project?.issues ?? []).filter((i) => i.status === status);
  const reviewIssues = byStatus('review');
  const cancelledIssues = byStatus('cancelled');
  const selectedReviewIssues = reviewIssues.filter((issue) => selected.has(issue.id));
  const allReviewSelected = reviewIssues.length > 0 && selectedReviewIssues.length === reviewIssues.length;
  const approveMany = useMutation({
    mutationFn: async (options: ApproveOptions) => {
      let ok = 0;
      const failed: string[] = [];
      for (const issue of selectedReviewIssues) {
        try {
          await api.issues.approve(issue.id, options);
          ok += 1;
        } catch (e) {
          failed.push(`${issue.key}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok > 0) toast.success(`Approved ${ok} ${ok === 1 ? 'story' : 'stories'}`);
      if (failed.length > 0) toast.error(failed.slice(0, 3).join('\n'));
      setApproveOpen(false);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['branches', id] });
    },
    onError: (e) => toast.error(String(e)),
  });

  useEffect(() => {
    const issues = project?.issues;
    if (!issues) return;
    const prev = prevStatus.current;
    const seeded = prev.size > 0;
    const justMoved = new Set<string>();
    for (const issue of issues) {
      const before = prev.get(issue.id);
      // Only flag a real transition, and never on the very first load (require a prior snapshot).
      if (seeded && before !== undefined && before !== issue.status) justMoved.add(issue.id);
      prev.set(issue.id, issue.status);
    }
    if (justMoved.size === 0) return; // no status changed — skip the re-render the setMoved would cause
    setMoved(justMoved);
    const t = setTimeout(() => setMoved(new Set()), 700); // clear so the animation can replay next time
    return () => clearTimeout(t);
  }, [project?.issues]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedColumns]));
    } catch {
      /* localStorage may be unavailable in hardened browser contexts */
    }
  }, [collapsedColumns]);

  const toggleColumn = (status: IssueStatus) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  // SYM-25: one-click expand — focus a single column by collapsing every other one. Clicking the
  // button again (when this column is already the only expanded one) restores the columns. The
  // existing per-column chevron (SYM-23) still works for granular collapse/expand.
  // SYM-26 (issue 1): on entry we snapshot the current collapsed set and on restore we return to it,
  // so columns the user had collapsed *before* focusing stay collapsed. We read collapsedColumns /
  // focusSnapshot straight from the render closure (handlers always see current values) rather than
  // nesting two functional updaters.
  const toggleFocus = (status: IssueStatus) => {
    const expanded = COLUMNS.filter((s) => !collapsedColumns.has(s));
    const isFocused = expanded.length === 1 && expanded[0] === status;
    if (isFocused) {
      setCollapsedColumns(focusSnapshot ?? new Set());
      setFocusSnapshot(null);
    } else {
      // Capture the pre-focus state only on first entry, so switching focus A→B keeps the original
      // snapshot rather than recording B's all-but-A collapsed set.
      if (focusSnapshot === null) setFocusSnapshot(collapsedColumns);
      setCollapsedColumns(new Set(COLUMNS.filter((s) => s !== status)));
    }
  };

  if (!project) return <Loading />;

  const toggleIssue = (issueId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  };
  const toggleAllReview = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allReviewSelected) {
        for (const issue of reviewIssues) next.delete(issue.id);
      } else {
        for (const issue of reviewIssues) next.add(issue.id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        back={{ to: '/' }}
        icon={<ProjectChip color={project.color}>{project.key}</ProjectChip>}
        title={project.name}
        actions={
          <>
            <Button onClick={() => setAskOpen(true)}>
              <Sparkles className="h-4 w-4 text-indigo-300" /> Ask
            </Button>
            {reviewIssues.length > 0 && (
              <Button onClick={toggleAllReview}>
                {allReviewSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                Review
              </Button>
            )}
            {selectedReviewIssues.length > 0 && (
              <Button variant="primary" disabled={approveMany.isPending} onClick={() => setApproveOpen(true)}>
                <Check className="h-4 w-4" /> Approve selected
              </Button>
            )}
            {cancelledIssues.length > 0 && (
              <Button onClick={() => setShowCancelled((v) => !v)}>
                <Ban className="h-4 w-4" /> Cancelled {cancelledIssues.length}
              </Button>
            )}
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> New issue
            </Button>
          </>
        }
      />

      <ProjectTabs projectId={project.id} />

      {open && (
        <NewIssueForm
          projectId={project.id}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            qc.invalidateQueries({ queryKey: ['project', id] });
          }}
        />
      )}

      <div className="flex flex-1 gap-3 overflow-x-auto">
        {(() => {
          // SYM-25: a column is "focused" when it is the *only* expanded one — that's the state
          // toggleFocus targets, and what flips the header button between Maximize2/Minimize2.
          const expandedColumns = COLUMNS.filter((s) => !collapsedColumns.has(s));
          return COLUMNS.map((status) => {
          const items = byStatus(status);
          const meta = STATUS_META[status];
          const isCollapsed = collapsedColumns.has(status);
          const isFocused = expandedColumns.length === 1 && expandedColumns[0] === status;
          // Collapsed columns shrink to a narrow strip; expanded columns share the freed width via
          // flex-1 so e.g. Done grows when its neighbours are collapsed. transition-all animates the
          // width change (suppressed under prefers-reduced-motion via globals.css).
          if (isCollapsed) {
            return (
              <button
                key={status}
                type="button"
                aria-label={`Expand ${meta.label}`}
                aria-expanded={false}
                onClick={() => toggleColumn(status)}
                className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-md py-2 text-muted transition-all hover:bg-hover hover:text-fg"
              >
                <ChevronRight className="h-4 w-4 shrink-0" />
                <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot} ${status === 'in_progress' ? 'anim-pulse-dot' : ''}`} />
                <span className="text-xs text-subtle">{items.length}</span>
                <span className="text-xs font-medium [writing-mode:vertical-rl]">{meta.label}</span>
              </button>
            );
          }
          return (
            <div key={status} className="flex min-w-[180px] flex-1 flex-col transition-all">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className={`h-2 w-2 rounded-full ${meta.dot} ${status === 'in_progress' ? 'anim-pulse-dot' : ''}`} />
                <span className="text-xs font-medium text-fg">{meta.label}</span>
                <span className="text-xs text-subtle">{items.length}</span>
                <button
                  type="button"
                  aria-label={isFocused ? 'Restore all columns' : `Expand ${meta.label}`}
                  aria-pressed={isFocused}
                  onClick={() => toggleFocus(status)}
                  className="ml-auto grid h-5 w-5 place-items-center rounded text-muted hover:bg-hover hover:text-fg"
                >
                  {isFocused ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  aria-label={`Collapse ${meta.label}`}
                  aria-expanded={true}
                  onClick={() => toggleColumn(status)}
                  className="grid h-5 w-5 place-items-center rounded text-muted hover:bg-hover hover:text-fg"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
              {/* SYM-26 (issue 2): a focused column spans the full board width, so flow its cards into
                  a responsive auto-fill grid instead of one stretched single column. Non-focused
                  (narrow) columns keep the single vertical stack. IssueCard has no fixed width, so it
                  fills its grid cell. */}
              <div className={isFocused ? 'grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]' : 'flex flex-col gap-2'}>
                {items.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-subtle">
                    No issues
                  </p>
                ) : (
                  items.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      selectable={status === 'review'}
                      selected={selected.has(issue.id)}
                      justMoved={moved.has(issue.id)}
                      onToggle={() => toggleIssue(issue.id)}
                    />
                  ))
                )}
              </div>
            </div>
          );
          });
        })()}
      </div>
      {showCancelled && cancelledIssues.length > 0 && (
        <div className="anim-card-in mt-4 border-t border-border pt-4">
          <div className="mb-2 flex items-center gap-2 px-1">
            <span className={`h-2 w-2 rounded-full ${STATUS_META['cancelled'].dot}`} />
            <span className="text-xs font-medium text-fg">{STATUS_META['cancelled'].label}</span>
            <span className="text-xs text-subtle">{cancelledIssues.length}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {cancelledIssues.map((issue) => (
              <div key={issue.id} className="w-[220px]">
                <IssueCard issue={issue} />
              </div>
            ))}
          </div>
        </div>
      )}
      {approveOpen && (
        <ApproveDialog
          projectId={project.id}
          initialBranch={project.default_branch}
          count={selectedReviewIssues.length}
          pending={approveMany.isPending}
          onCancel={() => setApproveOpen(false)}
          onConfirm={(options) => approveMany.mutate(options)}
        />
      )}
      {askOpen && (
        <AskPanel
          projectId={project.id}
          projectKey={project.key}
          projectName={project.name}
          defaultAgent={project.agent}
          onClose={() => setAskOpen(false)}
        />
      )}
    </div>
  );
}

// SYM-23: seed the collapsed-columns set from localStorage. Only keep values that are real board
// columns so a stale or hand-edited key can't poison the set; an unreadable key yields all-expanded.
function readCollapsed(): Set<IssueStatus> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const valid = Array.isArray(parsed)
      ? parsed.filter((s): s is IssueStatus => COLUMNS.includes(s))
      : [];
    return new Set(valid);
  } catch {
    return new Set();
  }
}

function IssueCard({
  issue,
  selectable = false,
  selected = false,
  justMoved = false,
  onToggle,
}: {
  issue: BoardIssue;
  selectable?: boolean;
  selected?: boolean;
  justMoved?: boolean;
  onToggle?: () => void;
}) {
  // A status change unmounts/remounts the card in its new column; `justMoved` picks the entrance
  // animation (lift-drop vs. plain fade-in). Freeze it at mount so that when `moved` clears 700ms
  // later the class doesn't flip lift-drop→card-in on the still-mounted element — swapping the
  // CSS animation-name would restart it and flash the card. A real move remounts the card, so the
  // lift-drop still replays on every genuine transition. The ring stays prop-driven so it fades out
  // smoothly via the Panel's `transition` once the move settles.
  const [anim] = useState(() => (justMoved ? 'anim-lift-drop' : 'anim-card-in'));
  const movedRing = justMoved ? 'border-indigo-400/70 ring-2 ring-indigo-400/60' : '';
  return (
    <Link to={`/issues/${issue.id}`} className="block">
      <Panel interactive className={`${anim} ${movedRing} p-3 ${selected ? 'border-indigo-500/80' : ''}`}>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {issue.status === 'in_progress' && (
              <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META.in_progress.dot} anim-pulse-dot`} />
            )}
            {selectable && (
              <button
                type="button"
                className="grid h-5 w-5 place-items-center rounded text-muted hover:bg-hover hover:text-fg"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle?.();
                }}
              >
                {selected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              </button>
            )}
            <span className="font-mono text-[11px] text-muted">{issue.key}</span>
          </div>
          <span className={`text-[10px] ${PRIORITY_META[issue.priority].color}`}>{issue.priority > 0 ? PRIORITY_META[issue.priority].label : ''}</span>
        </div>
        <p className="mb-2 text-sm leading-snug text-fg">{issue.title}</p>
        <div className="flex items-center gap-2 text-[10px]">
          {/* SYM-32: show the live phase chip for in-progress issues (current_phase is null otherwise,
              so the footer never collapses to empty — the type label always remains). Replaces the
              former auto/manual mode chip, per the acceptance criteria. */}
          {issue.current_phase && (
            <span className={`rounded px-1.5 py-0.5 ${PHASE_META[issue.current_phase].badge}`}>
              {PHASE_META[issue.current_phase].label}
            </span>
          )}
          <span className="text-subtle">{issue.type}</span>
          {/* SYM-29: an approved story whose merge/push failed — flag it so reviewers can resolve it. */}
          {issue.merge_conflict && (
            <Badge className="ml-auto bg-red-500/15 text-red-300" >
              <GitMerge className="h-3 w-3" /> git conflict
            </Badge>
          )}
        </div>
      </Panel>
    </Link>
  );
}

// SYM-65: the "create issue" card. Redesigned onto the shared `Modal` dialog primitive (matching
// ApproveDialog / the request-changes dialog) so it no longer shoves the board down on open and gets
// focus-trap + Escape + scroll-lock + focus-restore for free. The body is a real <form> grouped into
// "what" (title/type/priority/description/AC/attachments) and a labeled "Execution" fieldset
// (mode/status/thinking effort) so the secondary run-controls stay tidy instead of crowding the
// primary fields. The contract is unchanged — same `api.issues.create` payload.
function NewIssueForm({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    title: '',
    type: 'feature',
    priority: 2,
    mode: 'auto',
    status: 'todo',
    thinking_effort: '', // SYM-46: '' = inherit the project/engine default
    description: '',
    acceptance_criteria: '',
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api.issues.create({
        project_id: projectId,
        title: form.title.trim(),
        type: form.type as Issue['type'],
        priority: form.priority as Issue['priority'],
        mode: form.mode as Issue['mode'],
        status: form.status as IssueStatus,
        thinking_effort: (form.thinking_effort || null) as Issue['thinking_effort'],
        description: form.description || null,
        acceptance_criteria: form.acceptance_criteria || null,
        attachment_ids: attachments.map((a) => a.id),
      }),
    onSuccess: () => {
      toast.success('Issue created');
      onCreated();
    },
    onError: (e) => toast.error(String(e)),
  });

  const canSubmit = form.title.trim().length > 0 && !create.isPending;
  const submit = () => {
    if (canSubmit) create.mutate();
  };
  // Mid-create the dialog can't be dismissed (matches the disabled controls): Escape / backdrop /
  // close + Cancel all no-op while the mutation is in flight, so a half-built issue can't be lost.
  const close = () => {
    if (!create.isPending) onClose();
  };

  return (
    <Modal
      onClose={close}
      size="lg"
      icon={<FilePlus2 className="h-4 w-4 text-indigo-300" />}
      title="New issue"
      footer={
        <>
          <span className="mr-auto hidden self-center text-xs text-subtle sm:block">⌘/Ctrl + Enter to create</span>
          <Button onClick={close} disabled={create.isPending}>Cancel</Button>
          <Button type="submit" form="new-issue-form" variant="primary" disabled={!canSubmit} loading={create.isPending}>
            Create issue
          </Button>
        </>
      }
    >
      <form
        id="new-issue-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        // Power-user submit from anywhere in the form (incl. the textareas, where plain Enter is a newline).
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="space-y-4"
      >
        <Field label="Title" required>
          <Input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="What needs to be done?"
            autoFocus
            required
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="feature">feature</option>
              <option value="bug">bug</option>
              <option value="chore">chore</option>
              <option value="epic">epic</option>
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}>
              <option value={1}>Urgent</option>
              <option value={2}>High</option>
              <option value={3}>Medium</option>
              <option value={4}>Low</option>
              <option value={0}>None</option>
            </Select>
          </Field>
        </div>

        <Field label="Description">
          <Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Context, links, or anything the agent should know…" />
        </Field>
        <Field label="Acceptance criteria">
          <Textarea rows={3} value={form.acceptance_criteria} onChange={(e) => setForm({ ...form, acceptance_criteria: e.target.value })} placeholder="- …" />
        </Field>

        <Field label="Attachments" hint="Paste a screenshot, drop a file, or choose one — agents read them while building.">
          <AttachmentInput
            projectId={projectId}
            value={attachments}
            onChange={setAttachments}
            disabled={create.isPending}
          />
        </Field>

        {/* SYM-65: group the secondary "how it runs" controls so they stay tidy below the primary fields. */}
        <fieldset className="border-t border-border pt-4">
          <legend className="mb-3 block text-xs font-semibold uppercase tracking-wide text-subtle">Execution</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Mode">
              <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="manual">manual (run by hand)</option>
                <option value="auto">auto (orchestrator picks up)</option>
              </Select>
            </Field>
            <Field label="Initial status">
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="backlog">backlog</option>
                <option value="todo">todo</option>
              </Select>
            </Field>
            {/* SYM-46: per-issue extended-thinking override; inherit = the project/engine default. */}
            <Field label="Thinking effort">
              <Select value={form.thinking_effort} onChange={(e) => setForm({ ...form, thinking_effort: e.target.value })}>
                <option value="">inherit (project default)</option>
                {THINKING_EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
