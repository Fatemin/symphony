import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUp, Bug, FileText, RotateCcw, Sparkles, X } from 'lucide-react';
import type { AgentType, AskMessage, AskSuggestion, Attachment, IssueStatus } from '../../shared/types';
import { AGENT_OPTIONS } from '../../shared/models';
import { api, attachmentUrl } from '../api';
import { AttachmentInput } from './AttachmentInput';
import { Markdown } from './Markdown';
import { Button, ConfirmDialog, PendingIndicator, Select, Textarea, useModalDialog } from './ui';

type Turn = AskMessage & { suggestion?: AskSuggestion | null; converted?: boolean };

// Map a persisted history turn to a panel turn. Restores the SYM-28 suggestion card and SYM-35
// attachments so both survive a reseed. Shared by the initial seed and the open-drawer reconcile.
const toTurn = (m: AskMessage): Turn => ({
  role: m.role,
  content: m.content,
  suggestion: m.suggestion,
  attachments: m.attachments,
});

// SYM-21: the Ask drawer is user-resizable. Width is a controlled pixel value (not a Tailwind class)
// persisted to localStorage so it survives the per-open remount (Board renders AskPanel only while
// askOpen). DEFAULT_WIDTH matches the previous static `max-w-lg` (32rem) so existing users see no
// jump on first load.
const WIDTH_KEY = 'ask-panel-width';
const DEFAULT_WIDTH = 512;
const MIN_WIDTH = 360;
// Keep a backdrop strip reachable on the left so click-to-close still works at max width.
const VIEWPORT_GUTTER = 48;
const KEYBOARD_STEP = 24;

function maxWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_GUTTER);
}

function clampWidth(px: number): number {
  return Math.min(Math.max(px, MIN_WIDTH), maxWidth());
}

function readStoredWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(parsed) && parsed > 0) return clampWidth(parsed);
  } catch {
    /* localStorage may be unavailable in hardened browser contexts — fall through */
  }
  return clampWidth(DEFAULT_WIDTH);
}

function persistWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* localStorage may be unavailable in hardened browser contexts */
  }
}

interface AskPanelProps {
  projectId: string;
  projectKey: string;
  projectName: string;
  /** The project's configured agent ('' ⇒ global default) — preselected in the agent picker. */
  defaultAgent: AgentType | null;
  onClose: () => void;
}

export function AskPanel({ projectId, projectKey, projectName, defaultAgent, onClose }: AskPanelProps) {
  const qc = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [agent, setAgent] = useState<AgentType | ''>(defaultAgent ?? '');
  // SYM-82: clearing today's conversation is irreversible, so the reset button opens a ConfirmDialog.
  const [resetOpen, setResetOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The panel remounts on every open (Board renders it only while askOpen), so this seeds today's
  // persisted conversation exactly once per open without stomping turns the user adds afterward.
  const seeded = useRef(false);
  // SYM-21: drag-to-resize width. Seeded from localStorage (re-clamped to the current viewport),
  // persisted on commit (drag end / keyboard step), not on every move.
  const [width, setWidth] = useState(readStoredWidth);
  // Tracks the in-flight drag origin; null when idle. setPointerCapture keeps move/up firing even
  // when the cursor leaves the thin handle, so no window-level listeners are needed.
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // SYM-59: render the drawer as a native modal <dialog> for focus-trap, Escape-to-close, focus
  // restore, and a top-layer surface (escapes the .anim-page-in transform). The panel keeps its own
  // resize/persist behaviour; the ::backdrop replaces the hand-rolled click-to-close overlay.
  const { ref: dialogRef, handleCancel } = useModalDialog(onClose);

  useEffect(() => {
    // A width stored on a larger screen must never exceed a now-smaller viewport (the backdrop has
    // to stay clickable). Re-clamp on mount and on every window resize.
    const reclamp = () => setWidth((w) => clampWidth(w));
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, []);

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    // Suppress text selection and force the resize cursor for the whole drag, even over the backdrop.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The panel is anchored right, so dragging the left edge LEFT (clientX shrinks) widens it.
    setWidth(clampWidth(drag.current.startWidth + (drag.current.startX - e.clientX)));
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    // Read the latest committed width via the functional updater (no stale closure / extra ref) and
    // persist it. setPointerCapture is released automatically on pointerup/cancel.
    setWidth((w) => {
      persistWidth(w);
      return w;
    });
  };

  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // Mirror the drag convention: ArrowLeft = wider, ArrowRight = narrower.
    const next = clampWidth(width + (e.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP));
    setWidth(next);
    persistWidth(next);
  };

  // SYM-48: the panel remounts on every open (Board renders it only while askOpen). On a quick
  // reopen this query first emits STALE cache — possibly the pre-reply EMPTY history captured before
  // the in-flight reply landed — so seeding from that first emission dropped a reply that completed
  // while the panel was closed. `refetchOnMount: 'always'` forces a fresh fetch this mount (and we
  // gate the seed on `isFetchedAfterMount` below, so the stale cache never seeds). `refetchOnWindow
  // Focus` + a modest `refetchInterval` then keep an open drawer reconciled, so a reply landing
  // after a mid-run reopen appears without re-toggling (matches Board's 3s project poll; this is a
  // cheap today's-rows DB read and structural sharing keeps `history` stable when unchanged).
  const { data: history, isFetchedAfterMount } = useQuery({
    queryKey: ['ask-history', projectId],
    queryFn: () => api.projects.askHistory(projectId),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 3000,
  });

  const reset = useMutation({
    mutationFn: () => api.projects.askReset(projectId),
    onSuccess: async () => {
      setTurns([]);
      // SYM-48: cancel any in-flight history fetch (the open-drawer poll) BEFORE refetching. A poll
      // the server processed before this delete could otherwise resolve with the old turns and the
      // reconcile below would resurrect the just-cleared conversation; cancelling discards its result
      // so only the post-delete (empty) refetch lands.
      await qc.cancelQueries({ queryKey: ['ask-history', projectId] });
      qc.invalidateQueries({ queryKey: ['ask-history', projectId] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const ask = useMutation({
    mutationFn: (vars: { question: string; attachmentIds: string[] }) =>
      api.projects.ask(projectId, {
        question: vars.question,
        history: turns.map(({ role, content }) => ({ role, content })), // turns before this question
        agent: agent || undefined,
        attachment_ids: vars.attachmentIds,
      }),
    onSuccess: (res) => {
      setTurns((prev) => [...prev, { role: 'assistant', content: res.answer, suggestion: res.suggestion }]);
      // The server just persisted both turns; refresh the cache so `history` matches the live turns
      // (the SYM-48 reconcile no-ops while lengths are equal) and a later reopen reseeds from fresh
      // data rather than stale cache.
      qc.invalidateQueries({ queryKey: ['ask-history', projectId] });
    },
    onError: (e) => {
      toast.error(String(e));
      // Drop the optimistic user turn that produced no answer so a retry is clean.
      setTurns((prev) => (prev[prev.length - 1]?.role === 'user' ? prev.slice(0, -1) : prev));
    },
  });

  // SYM-48: seed + reconcile today's conversation from the SERVER, not the cache. Declared after
  // `ask` so its `isPending` is in scope for the deps (a const referenced in deps before its own
  // declaration would hit the temporal dead zone). `isFetchedAfterMount` is true only once a fetch
  // completes during THIS mount, so the stale empty cache never wins the seed.
  useEffect(() => {
    if (!isFetchedAfterMount || !history) return;
    if (!seeded.current) {
      // First fresh fetch this open wins — even when empty — so a reply that completed while the
      // panel was closed is restored instead of dropped (the SYM-48 acceptance criterion).
      seeded.current = true;
      setTurns(history.messages.map(toTurn));
      return;
    }
    // Already seeded: adopt out-of-band growth (e.g. a reply that lands after a mid-run reopen)
    // WITHOUT stomping an in-flight send. During an active ask the optimistic user turn (submit)
    // is preserved; the happy path never reseeds because onSuccess already left turns.length ===
    // history.length. A grow-only replace keeps things simple (the local `converted` flag is only
    // lost on a genuine out-of-band reseed, which is acceptable).
    if (!ask.isPending) {
      setTurns((prev) =>
        history.messages.length > prev.length ? history.messages.map(toTurn) : prev,
      );
    }
  }, [history, isFetchedAfterMount, ask.isPending]);

  const convert = useMutation({
    mutationFn: (vars: { index: number; suggestion: AskSuggestion; status: IssueStatus }) =>
      api.issues.create({
        project_id: projectId,
        title: vars.suggestion.title,
        type: vars.suggestion.type,
        description: vars.suggestion.description || null,
        acceptance_criteria: vars.suggestion.acceptance_criteria || null,
        status: vars.status,
        mode: 'manual',
        priority: 2,
      }),
    onSuccess: (issue, vars) => {
      toast.success(`Created ${issue.key} — ${issue.title}`);
      setTurns((prev) => prev.map((t, i) => (i === vars.index ? { ...t, converted: true } : t)));
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (e) => toast.error(String(e)),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, ask.isPending]);

  const submit = () => {
    const question = input.trim();
    if (!question || ask.isPending) return;
    const sent = attachments; // snapshot so the optimistic turn keeps them after we clear the input
    setTurns((prev) => [...prev, { role: 'user', content: question, attachments: sent }]);
    setInput('');
    setAttachments([]);
    ask.mutate({ question, attachmentIds: sent.map((a) => a.id) });
  };

  return (
    <dialog
      ref={dialogRef}
      onCancel={handleCancel}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose(); // a click on the ::backdrop reports the dialog as target
      }}
      aria-label={`Ask ${projectKey}`}
      style={{ width }}
      className="anim-drawer-in left-auto right-0 top-0 m-0 flex h-[100dvh] flex-col border-l border-border bg-panel p-0 text-fg shadow-[var(--elev-3)] backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        {/* SYM-21: left-edge resizer. Lives inside the dialog (not the backdrop) so a drag never
            reaches the ::backdrop click-to-close. role="separator" + Arrow-key handling gives
            keyboard parity with the pointer drag. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuenow={Math.round(width)}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={Math.round(maxWidth())}
          tabIndex={0}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onHandleKeyDown}
          // SYM-73: accent hover/focus fill + ring route through tokens. The 1.5px-wide handle keeps a
          // 1px INSET ring (an offset global outline would draw outside the thin handle and be clipped),
          // swapped to the themed `--color-ring`; the accent fills use `--color-accent`.
          className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-[var(--color-accent)]/40 focus-visible:bg-[var(--color-accent)]/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
        />
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-300" />
            <div>
              <div className="text-sm font-semibold text-fg">Ask {projectKey}</div>
              <div className="text-xs text-muted">{projectName}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select
              aria-label="Agent"
              className="w-auto py-1 text-xs"
              value={agent}
              onChange={(e) => setAgent(e.target.value as AgentType | '')}
            >
              <option value="">default agent</option>
              {AGENT_OPTIONS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </Select>
            <button
              type="button"
              aria-label="Reset conversation"
              title="Reset today's conversation"
              className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
              disabled={reset.isPending || (turns.length === 0 && !ask.isPending)}
              onClick={() => setResetOpen(true)}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-hover hover:text-fg"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
          {turns.length === 0 && !ask.isPending && (
            <div className="mt-10 text-center text-sm text-muted">
              <Sparkles className="mx-auto mb-2 h-6 w-6 text-indigo-300/70" />
              Ask anything about <span className="text-fg">{projectName}</span> — how a feature works,
              its current state, or where to improve. Actionable answers can be turned into a feature
              or bug.
            </div>
          )}
          {turns.map((turn, i) => (
            <TurnBubble
              key={i}
              turn={turn}
              busy={convert.isPending}
              onConvert={(status) =>
                turn.suggestion && convert.mutate({ index: i, suggestion: turn.suggestion, status })
              }
            />
          ))}
          {/* SYM-77: self-starting elapsed counter so a slow Ask reads as in-progress, not hung. */}
          {ask.isPending && <PendingIndicator label="Thinking…" />}
        </div>

        <div className="space-y-2 border-t border-border p-3">
          <AttachmentInput
            projectId={projectId}
            value={attachments}
            onChange={setAttachments}
            disabled={ask.isPending}
          />
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask about this project…  (Enter to send, Shift+Enter for newline)"
              autoFocus
            />
            <Button variant="primary" className="h-9 px-3" disabled={!input.trim() || ask.isPending} onClick={submit}>
              <ArrowUp className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      {/* SYM-82: resetting clears today's whole conversation irreversibly — guard it with the shared
          ConfirmDialog. It opens as a second top-layer <dialog> stacked above this drawer. */}
      {resetOpen && (
        <ConfirmDialog
          title="Reset conversation?"
          description="This clears today's Ask conversation for this project and can't be undone."
          confirmLabel="Reset"
          cancelLabel="Keep"
          confirmIcon={<RotateCcw className="h-4 w-4" />}
          pending={reset.isPending}
          onConfirm={() => reset.mutate()}
          onClose={() => setResetOpen(false)}
        />
      )}
    </dialog>
  );
}

function TurnBubble({
  turn,
  busy,
  onConvert,
}: {
  turn: Turn;
  busy: boolean;
  onConvert: (status: IssueStatus) => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {turn.content && (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white">
            {turn.content}
          </div>
        )}
        {turn.attachments && turn.attachments.length > 0 && (
          <TurnAttachments attachments={turn.attachments} />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="max-w-[95%] rounded-lg border border-border bg-bg-2 px-3 py-2 text-sm leading-relaxed text-fg">
        <Markdown source={turn.content} />
      </div>
      {turn.suggestion && <SuggestionCard suggestion={turn.suggestion} converted={turn.converted} busy={busy} onConvert={onConvert} />}
    </div>
  );
}

function TurnAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {attachments.map((att) => (
        <a
          key={att.id}
          href={attachmentUrl(att.id, true)}
          target="_blank"
          rel="noreferrer"
          title={att.filename}
          className="block"
        >
          {att.mime.startsWith('image/') ? (
            <img
              src={attachmentUrl(att.id)}
              alt={att.filename}
              loading="lazy"
              className="h-16 w-16 rounded-md border border-border object-cover"
            />
          ) : (
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-xs text-fg hover:border-indigo-500/50">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[8rem] truncate">{att.filename}</span>
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  converted,
  busy,
  onConvert,
}: {
  suggestion: AskSuggestion;
  converted?: boolean;
  busy: boolean;
  onConvert: (status: IssueStatus) => void;
}) {
  const Icon = suggestion.type === 'bug' ? Bug : Sparkles;
  return (
    <div className="max-w-[95%] rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-indigo-300">
        <Icon className="h-3.5 w-3.5" />
        Turn this into a {suggestion.type}?
      </div>
      <div className="text-sm font-medium text-fg">{suggestion.title}</div>
      {suggestion.description && (
        <div className="mt-1 text-xs text-muted">
          <Markdown source={suggestion.description} />
        </div>
      )}
      {suggestion.acceptance_criteria && (
        <pre className="mt-2 whitespace-pre-wrap rounded bg-bg-2 px-2 py-1.5 text-[11px] text-muted">
          {suggestion.acceptance_criteria}
        </pre>
      )}
      <div className="mt-2 flex items-center gap-2">
        {converted ? (
          <span className="text-xs text-green-400">✓ Created</span>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => onConvert('todo')}>
              Create {suggestion.type} (Todo)
            </Button>
            <Button disabled={busy} onClick={() => onConvert('backlog')}>
              Add to Backlog
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
