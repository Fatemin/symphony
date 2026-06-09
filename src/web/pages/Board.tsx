import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Plus } from 'lucide-react';
import type { Issue, IssueStatus } from '../../shared/types';
import { api } from '../api';
import { Button, Field, Input, Panel, Select, Textarea } from '../components/ui';
import { PRIORITY_META, STATUS_META } from '../lib/format';

const COLUMNS: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

export function Board() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id!),
    refetchInterval: 3000,
  });
  const [open, setOpen] = useState(false);

  if (!project) return <div className="p-8 text-sm text-slate-500">Loading…</div>;

  const byStatus = (status: IssueStatus) => project.issues.filter((i) => i.status === status);

  return (
    <div className="flex h-full flex-col p-6">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-slate-500 hover:text-slate-300">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="grid h-7 w-7 place-items-center rounded text-xs font-bold" style={{ background: project.color + '33', color: project.color }}>
            {project.key}
          </span>
          <h1 className="text-lg font-semibold">{project.name}</h1>
        </div>
        <Button variant="primary" onClick={() => setOpen((v) => !v)}>
          <Plus className="h-4 w-4" /> New issue
        </Button>
      </header>

      {open && <NewIssueForm projectId={project.id} onDone={() => { setOpen(false); qc.invalidateQueries({ queryKey: ['project', id] }); }} />}

      <div className="grid flex-1 grid-cols-5 gap-3 overflow-x-auto">
        {COLUMNS.map((status) => {
          const items = byStatus(status);
          return (
            <div key={status} className="flex min-w-[180px] flex-col">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className={`h-2 w-2 rounded-full ${STATUS_META[status].dot}`} />
                <span className="text-xs font-medium text-slate-300">{STATUS_META[status].label}</span>
                <span className="text-xs text-slate-600">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: Issue }) {
  return (
    <Link to={`/issues/${issue.id}`}>
      <Panel className="p-3 transition hover:border-indigo-500/60">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-mono text-[11px] text-slate-500">{issue.key}</span>
          <span className={`text-[10px] ${PRIORITY_META[issue.priority].color}`}>
            {issue.priority > 0 ? PRIORITY_META[issue.priority].label : ''}
          </span>
        </div>
        <p className="mb-2 text-sm leading-snug text-slate-200">{issue.title}</p>
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`rounded px-1.5 py-0.5 ${issue.mode === 'auto' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-600/20 text-slate-400'}`}>
            {issue.mode}
          </span>
          <span className="text-slate-600">{issue.type}</span>
        </div>
      </Panel>
    </Link>
  );
}

function NewIssueForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [form, setForm] = useState({
    title: '',
    type: 'feature',
    priority: 2,
    mode: 'manual',
    status: 'todo',
    description: '',
    acceptance_criteria: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api.issues.create({
        project_id: projectId,
        title: form.title,
        type: form.type as Issue['type'],
        priority: form.priority as Issue['priority'],
        mode: form.mode as Issue['mode'],
        status: form.status as IssueStatus,
        description: form.description || null,
        acceptance_criteria: form.acceptance_criteria || null,
      }),
    onSuccess: () => {
      toast.success('Issue created');
      onDone();
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <Panel className="mb-5 p-4">
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-4">
          <Field label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What needs to be done?" autoFocus />
          </Field>
        </div>
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
        <div className="col-span-2">
          <Field label="Description">
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Acceptance criteria">
            <Textarea rows={3} value={form.acceptance_criteria} onChange={(e) => setForm({ ...form, acceptance_criteria: e.target.value })} placeholder="- …" />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" disabled={!form.title || create.isPending} onClick={() => create.mutate()}>
          Create issue
        </Button>
      </div>
    </Panel>
  );
}
