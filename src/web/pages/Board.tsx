import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Check, CheckSquare, ChevronDown, ChevronRight, FilePlus2, GitMerge, Maximize2, Minimize2, Plus, Sparkles, Square, X } from 'lucide-react';
import type { Attachment, BoardIssue, Issue, IssueStatus } from '../../shared/types';
import { api, THINKING_EFFORT_OPTIONS, type ApproveOptions } from '../api';
import { ApproveDialog } from '../components/ApproveDialog';
import { AskPanel } from '../components/AskPanel';
import { AttachmentInput } from '../components/AttachmentInput';
import { ProjectTabs } from '../components/ProjectTabs';
import { Badge, Button, EmptyState, Field, Input, Loading, PageHeader, Panel, ProjectChip, SegmentedControl, Textarea } from '../components/ui';
import { ISSUE_SOURCE_META, PHASE_META, PRIORITY_META, STATUS_META } from '../lib/format';
import { groupIssues, type BoardGroupBy } from '../lib/boardGroups';

const COLUMNS: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

// SYM-78: how the board buckets cards. 'status' is the original kanban; 'source'/'type' render
// collapsible swimlanes. Persisted globally (like collapsedColumns) so the choice survives reloads.
const GROUP_BY_KEY = 'symphony.board.groupBy';
const GROUP_BY_VALUES: BoardGroupBy[] = ['status', 'source', 'type'];
const GROUP_BY_OPTIONS: { value: BoardGroupBy; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'source', label: 'Source' },
  { value: 'type', label: 'Type' },
];

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
  // SYM-81: batch-approve progress (drives the dialog's "Approving N of M…" label) + the per-issue
  // failure list rendered inline in the dialog so a partial failure is readable, not a clipped toast.
  const [approveProgress, setApproveProgress] = useState({ done: 0, total: 0 });
  const [approveFailed, setApproveFailed] = useState<string[]>([]);
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
  // SYM-78: the board's grouping axis (persisted) + the collapsed swimlanes in source/type mode.
  // collapsedGroups is transient (run-id keys churn); seeding it empty = all swimlanes expanded.
  const [groupBy, setGroupBy] = useState<BoardGroupBy>(() => readGroupBy());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const byStatus = (status: IssueStatus) => (project?.issues ?? []).filter((i) => i.status === status);
  const reviewIssues = byStatus('review');
  const cancelledIssues = byStatus('cancelled');
  const selectedReviewIssues = reviewIssues.filter((issue) => selected.has(issue.id));
  const allReviewSelected = reviewIssues.length > 0 && selectedReviewIssues.length === reviewIssues.length;
  const approveMany = useMutation({
    mutationFn: async (options: ApproveOptions) => {
      // Re-approve only what's still in review: a prior partial run already moved the succeeded
      // stories to `done`, so this naturally narrows to the failures on a retry.
      const targets = selectedReviewIssues;
      setApproveProgress({ done: 0, total: targets.length });
      setApproveFailed([]);
      let ok = 0;
      const failed: string[] = [];
      for (const issue of targets) {
        try {
          await api.issues.approve(issue.id, options);
          ok += 1;
        } catch (e) {
          failed.push(`${issue.key}: ${e instanceof Error ? e.message : String(e)}`);
        }
        setApproveProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok > 0) toast.success(`Approved ${ok} ${ok === 1 ? 'story' : 'stories'}`);
      // Always refresh so the merged stories leave the review column (and the branch list reflects
      // any new default target), whether or not some failed.
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['branches', id] });
      if (failed.length > 0) {
        // SYM-81: keep the dialog open and render the full per-issue failure list inline (the old
        // toast clipped to 3). The selection persists; the succeeded stories drop out of
        // selectedReviewIssues on the refetch, so Approve retries just the failures.
        setApproveFailed(failed);
        return;
      }
      setApproveFailed([]);
      setApproveOpen(false);
      setSelected(new Set());
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
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

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_BY_KEY, groupBy);
    } catch {
      /* localStorage may be unavailable in hardened browser contexts */
    }
  }, [groupBy]);

  // SYM-78: switching the axis clears the review selection (select + Approve are status-only), and
  // 'source'/'type' get collapsible swimlanes keyed by group id.
  const changeGroupBy = (next: BoardGroupBy) => {
    setGroupBy(next);
    if (next !== 'status') setSelected(new Set());
  };
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
            {/* SYM-78: review select-all + approve + the cancelled drawer are bound to the kanban
                (Status) view — the review gate is a per-status action, so they hide in source/type
                grouping (where cards are non-selectable and cancelled issues sit inside their group). */}
            {groupBy === 'status' && reviewIssues.length > 0 && (
              <Button onClick={toggleAllReview}>
                {allReviewSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                Review
              </Button>
            )}
            {groupBy === 'status' && selectedReviewIssues.length > 0 && (
              <Button
                variant="primary"
                disabled={approveMany.isPending}
                onClick={() => {
                  // Clear a prior run's progress/failures so reopening shows a clean dialog.
                  setApproveProgress({ done: 0, total: 0 });
                  setApproveFailed([]);
                  setApproveOpen(true);
                }}
              >

                <Check className="h-4 w-4" /> Approve selected
              </Button>
            )}
            {groupBy === 'status' && cancelledIssues.length > 0 && (
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

      {/* SYM-78: choose how the board buckets cards — Status (the original kanban), Source (one
          swimlane per review batch + a Manual catch-all), or Type (feature/bug/chore/epic).
          Persisted across reloads; switching away from Status clears the review selection. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-medium text-muted">Group by</span>
        <SegmentedControl
          size="sm"
          aria-label="Group issues by"
          value={groupBy}
          onChange={changeGroupBy}
          options={GROUP_BY_OPTIONS}
        />
      </div>

      {groupBy === 'status' ? (
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
                className="group flex w-10 shrink-0 flex-col items-center gap-2 rounded-md py-2 text-muted transition-all hover:bg-hover hover:text-fg"
              >
                <ChevronRight className="h-4 w-4 shrink-0" />
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${meta.dot} ${status === 'in_progress' ? 'anim-pulse-dot' : ''}`} />
                {/* SYM-70: pinned text-subtle on the hover wash (#222735 dark / #e2e8f0 light) is 4.38:1 —
                    just under AA. Flip to fg on hover like the sibling label/chevron already do. */}
                <span className="text-xs text-subtle group-hover:text-fg">{items.length}</span>
                <span className="text-xs font-medium [writing-mode:vertical-rl]">{meta.label}</span>
              </button>
            );
          }
          return (
            <div key={status} className="flex min-w-[180px] flex-1 flex-col transition-all">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span aria-hidden className={`h-2 w-2 rounded-full ${meta.dot} ${status === 'in_progress' ? 'anim-pulse-dot' : ''}`} />
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
                  <EmptyState
                    compact
                    title="No issues"
                    className="rounded-md border border-dashed border-border px-3 py-6 text-xs"
                  />
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
      ) : (
        <BoardSwimlanes
          issues={project.issues ?? []}
          groupBy={groupBy}
          collapsedGroups={collapsedGroups}
          onToggleGroup={toggleGroup}
          moved={moved}
        />
      )}
      {groupBy === 'status' && showCancelled && cancelledIssues.length > 0 && (
        <div className="anim-card-in mt-4 border-t border-border pt-4">
          <div className="mb-2 flex items-center gap-2 px-1">
            <span aria-hidden className={`h-2 w-2 rounded-full ${STATUS_META['cancelled'].dot}`} />
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
          pendingLabel={
            approveProgress.total > 1
              ? `Approving ${Math.min(approveProgress.done + 1, approveProgress.total)} of ${approveProgress.total}…`
              : 'Merging…'
          }
          error={approveFailed.length > 0 ? approveFailed.join('\n') : null}
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

// SYM-78: seed the persisted Group-by axis, validating against the known set so a stale/hand-edited
// key can't poison it (mirrors readCollapsed). An unreadable key falls back to the kanban ('status').
function readGroupBy(): BoardGroupBy {
  try {
    const raw = localStorage.getItem(GROUP_BY_KEY);
    return GROUP_BY_VALUES.includes(raw as BoardGroupBy) ? (raw as BoardGroupBy) : 'status';
  } catch {
    return 'status';
  }
}

// SYM-78: the source/type view — a vertical stack of collapsible swimlanes (one <section> per group),
// each body reusing the focused-column responsive grid so cards flow the same way they do on the
// kanban. Cards are NOT selectable here (the review gate is a Status-view action); the source badge on
// each card still shows provenance. groupIssues is pure, so all the ordering/labeling lives there.
function BoardSwimlanes({
  issues,
  groupBy,
  collapsedGroups,
  onToggleGroup,
  moved,
}: {
  issues: BoardIssue[];
  groupBy: Exclude<BoardGroupBy, 'status'>;
  collapsedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  moved: Set<string>;
}) {
  const groups = groupIssues(issues, groupBy);
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No issues yet"
        description="Create an issue or convert a review batch — they'll show up grouped here."
        className="mt-6"
      />
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-2">
      {groups.map((group) => {
        const collapsed = collapsedGroups.has(group.key);
        const bodyId = `board-group-${group.key}`;
        // Every issue in a source group shares one origin, so the first card is representative.
        const source = group.issues[0]?.source ?? 'manual';
        return (
          <section key={group.key} className="anim-card-in">
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              onClick={() => onToggleGroup(group.key)}
              className="mb-2 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-hover"
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
              )}
              {groupBy === 'source' ? (
                <Badge className={ISSUE_SOURCE_META[source].badge}>{group.label}</Badge>
              ) : (
                <span className="text-sm font-medium text-fg">{group.label}</span>
              )}
              <span className="text-xs text-subtle">{group.issues.length}</span>
            </button>
            {!collapsed && (
              <div id={bodyId} className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
                {group.issues.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} justMoved={moved.has(issue.id)} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
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
  // SYM-73: moved-card + selected emphasis route through the `--color-accent` token (was raw indigo)
  // so the highlight re-themes for light mode.
  const movedRing = justMoved ? 'border-[var(--color-accent)]/70 ring-2 ring-[var(--color-accent)]/60' : '';
  return (
    <Link to={`/issues/${issue.id}`} className="block">
      <Panel interactive className={`${anim} ${movedRing} p-3 ${selected ? 'border-[var(--color-accent)]/80' : ''}`}>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {issue.status === 'in_progress' && (
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_META.in_progress.dot} anim-pulse-dot`} />
            )}
            {selectable && (
              // SYM-74: icon-only review-select toggle. aria-label states the intent and aria-pressed
              // exposes the checked state, so assistive tech announces purpose + state (not just "button").
              // Mirrors the column focus toggle's aria-pressed convention above.
              <button
                type="button"
                aria-label={selected ? 'Deselect issue' : 'Select issue'}
                aria-pressed={selected}
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
          {/* SYM-78: provenance badge — shows in EVERY group mode so a review-converted issue reads as
              such even on the kanban. Manual issues (the default origin) carry no badge. SYM-29: an
              approved story whose merge/push failed sits beside it; both align to the card's right. */}
          {(issue.source !== 'manual' || issue.merge_conflict) && (
            <div className="ml-auto flex items-center gap-1.5">
              {issue.source !== 'manual' && (
                <Badge className={ISSUE_SOURCE_META[issue.source].badge}>
                  {ISSUE_SOURCE_META[issue.source].label}
                </Badge>
              )}
              {issue.merge_conflict && (
                <Badge tone="danger">
                  <GitMerge className="h-3 w-3" /> git conflict
                </Badge>
              )}
            </div>
          )}
        </div>
      </Panel>
    </Link>
  );
}

// SYM-68: the "create issue" card. Redesigned back to an INLINE (no-popup) composer — SYM-65 had
// moved it into a centered `Modal`, but the acceptance criteria here is to keep the no-popup mode.
// To pay for the inline footprint that originally pushed the board down, the card uses
// progressive-disclosure: the title + the two classifiers it almost always needs (type / priority)
// lead, and the heavier fields (description, acceptance criteria, attachments, the Execution
// run-controls) collapse behind an "Add details" toggle — so a quick add is one compact card, while
// power users expand in place. The enum controls are now tactile `SegmentedControl` chips instead of
// native `<Select>`s (all options visible, one tap, accent-tinted active state). The contract is
// unchanged — same `api.issues.create` payload.
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
    enable_workflow_tool: '', // SYM-67: '' = inherit, 'false' = off, 'true' = on
    description: '',
    acceptance_criteria: '',
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Progressive disclosure: keep the resting card small (the original inline form shoved the whole
  // board down). The secondary fields stay one click away, not gone.
  const [detailsOpen, setDetailsOpen] = useState(false);

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
        enable_workflow_tool:
          form.enable_workflow_tool === '' ? null : form.enable_workflow_tool === 'true',
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
  // Mid-create the card can't be dismissed (matches the disabled controls): Escape / close / Cancel
  // all no-op while the mutation is in flight, so a half-built issue can't be lost.
  const close = () => {
    if (!create.isPending) onClose();
  };

  return (
    <Panel elevated className="anim-card-in mb-4 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        // Power-user submit from anywhere in the form (incl. the textareas, where plain Enter is a
        // newline); Escape dismisses the inline card the way it would a dialog.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape' && !create.isPending) {
            e.preventDefault();
            close();
          }
        }}
        className="space-y-4"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold text-fg">
            <FilePlus2 className="h-4 w-4 text-indigo-300" /> New issue
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            disabled={create.isPending}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

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
            <SegmentedControl
              aria-label="Type"
              value={form.type}
              onChange={(v) => setForm({ ...form, type: v })}
              options={[
                { value: 'feature', label: 'Feature' },
                { value: 'bug', label: 'Bug' },
                { value: 'chore', label: 'Chore' },
                { value: 'epic', label: 'Epic' },
              ]}
            />
          </Field>
          <Field label="Priority">
            <SegmentedControl
              aria-label="Priority"
              value={form.priority}
              onChange={(v) => setForm({ ...form, priority: v })}
              options={[
                { value: 1, label: 'Urgent' },
                { value: 2, label: 'High' },
                { value: 3, label: 'Medium' },
                { value: 4, label: 'Low' },
                { value: 0, label: 'None' },
              ]}
            />
          </Field>
        </div>

        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls="new-issue-details"
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded text-xs font-medium text-muted transition hover:text-fg"
        >
          {detailsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {detailsOpen ? 'Hide details' : 'Add details'}
          <span className="font-normal text-subtle">— description, attachments, execution</span>
        </button>

        {detailsOpen && (
          <div id="new-issue-details" className="anim-card-in space-y-4">
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

            {/* Group the secondary "how it runs" controls so they stay tidy below the primary fields. */}
            <fieldset className="border-t border-border pt-4">
              <legend className="mb-3 block text-xs font-semibold uppercase tracking-wide text-subtle">Execution</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Mode">
                  <SegmentedControl
                    aria-label="Mode"
                    value={form.mode}
                    onChange={(v) => setForm({ ...form, mode: v })}
                    options={[
                      { value: 'manual', label: 'Manual', hint: 'Run by hand' },
                      { value: 'auto', label: 'Auto', hint: 'Orchestrator picks it up' },
                    ]}
                  />
                </Field>
                <Field label="Initial status">
                  <SegmentedControl
                    aria-label="Initial status"
                    value={form.status}
                    onChange={(v) => setForm({ ...form, status: v })}
                    options={[
                      { value: 'backlog', label: 'Backlog' },
                      { value: 'todo', label: 'Todo' },
                    ]}
                  />
                </Field>
              </div>
              {/* SYM-46: per-issue extended-thinking override; '' (inherit) = the project/engine default.
                  SYM-68: render as a SegmentedControl like the other enum pickers so every control in the
                  card speaks the same chip language. Labels stay lowercase — these are literal Claude Code
                  thinking keywords (think / think-hard / ultrathink), not free-form enums. */}
              <div className="mt-3">
                <Field label="Thinking effort">
                  <SegmentedControl
                    aria-label="Thinking effort"
                    size="sm"
                    value={form.thinking_effort}
                    onChange={(v) => setForm({ ...form, thinking_effort: v })}
                    options={[
                      { value: '', label: 'inherit', hint: 'Use the project / engine default' },
                      ...THINKING_EFFORT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
                    ]}
                  />
                </Field>
              </div>
              {/* SYM-67: per-issue Workflow-tool override; '' (inherit) = the project/engine default.
                  SYM-68: render as a SegmentedControl to match the other enum pickers in this card. */}
              <div className="mt-3">
                <Field label="Workflow tool">
                  <SegmentedControl
                    aria-label="Workflow tool"
                    size="sm"
                    value={form.enable_workflow_tool}
                    onChange={(v) => setForm({ ...form, enable_workflow_tool: v })}
                    options={[
                      { value: '', label: 'inherit', hint: 'Use the project / engine default' },
                      { value: 'false', label: 'off' },
                      { value: 'true', label: 'on', hint: 'Advanced' },
                    ]}
                  />
                </Field>
              </div>
            </fieldset>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <span className="mr-auto hidden self-center text-xs text-subtle sm:block">⌘/Ctrl + Enter to create</span>
          <Button type="button" onClick={close} disabled={create.isPending}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={create.isPending}>
            Create issue
          </Button>
        </div>
      </form>
    </Panel>
  );
}
