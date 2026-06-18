import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUp, Bug, Sparkles, X } from 'lucide-react';
import type { AgentType, AskMessage, AskSuggestion, IssueStatus } from '../../shared/types';
import { AGENT_OPTIONS } from '../../shared/models';
import { api } from '../api';
import { Markdown } from './Markdown';
import { Button, Select, Spinner, Textarea } from './ui';

type Turn = AskMessage & { suggestion?: AskSuggestion | null; converted?: boolean };

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
  const [agent, setAgent] = useState<AgentType | ''>(defaultAgent ?? '');
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (question: string) =>
      api.projects.ask(projectId, {
        question,
        history: turns.map(({ role, content }) => ({ role, content })), // turns before this question
        agent: agent || undefined,
      }),
    onSuccess: (res) =>
      setTurns((prev) => [...prev, { role: 'assistant', content: res.answer, suggestion: res.suggestion }]),
    onError: (e) => {
      toast.error(String(e));
      // Drop the optimistic user turn that produced no answer so a retry is clean.
      setTurns((prev) => (prev[prev.length - 1]?.role === 'user' ? prev.slice(0, -1) : prev));
    },
  });

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
    setTurns((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');
    ask.mutate(question);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-lg flex-col border-l border-border bg-panel shadow-xl">
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
          {ask.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Thinking…
            </div>
          )}
        </div>

        <div className="border-t border-border p-3">
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
      </aside>
    </div>
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
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white">
          {turn.content}
        </div>
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
