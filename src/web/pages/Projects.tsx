import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FolderGit2, Plus } from 'lucide-react';
import { api } from '../api';
import { suggestProjectKey } from '../../shared/keys';
import { Button, Field, Input, Panel, Textarea } from '../components/ui';
import { PathField } from '../components/PathField';

const EMPTY_FORM = { name: '', key: '', repo_path: '', default_branch: 'main', context: '', preview_command: '' };

export function Projects() {
  const qc = useQueryClient();
  const { data: projects, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // Track whether the user has hand-edited the Key so we stop auto-syncing it from the name.
  const [keyEdited, setKeyEdited] = useState(false);

  // Project keys are stored uppercase; compare case-insensitively against the already-loaded list.
  const keyTaken = !!form.key && (projects?.some((p) => p.key.toUpperCase() === form.key) ?? false);

  function resetForm() {
    setForm(EMPTY_FORM);
    setKeyEdited(false);
  }

  const create = useMutation({
    mutationFn: () => api.projects.create({ ...form, key: form.key || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
      resetForm();
      toast.success('Project created');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="mx-auto max-w-5xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <Button variant="primary" onClick={() => setOpen((v) => !v)}>
          <Plus className="h-4 w-4" /> New project
        </Button>
      </header>

      {open && (
        <Panel className="mb-6 p-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  // Keep the Key in sync with the derived default until the user edits it directly.
                  setForm((f) => ({ ...f, name, key: keyEdited ? f.key : suggestProjectKey(name) }));
                }}
                placeholder="My Web App"
              />
            </Field>
            <div>
              <Field label="Key">
                <Input
                  value={form.key}
                  onChange={(e) => {
                    setKeyEdited(true);
                    setForm((f) => ({ ...f, key: e.target.value.toUpperCase() }));
                  }}
                  placeholder="WEB"
                  maxLength={5}
                  aria-invalid={keyTaken || undefined}
                  className={keyTaken ? 'border-red-500 focus:border-red-500' : ''}
                />
              </Field>
              {keyTaken ? (
                <p className="mt-1 text-xs text-red-500">Key “{form.key}” is taken — pick a different one.</p>
              ) : (
                <p className="mt-1 text-xs text-muted">Used in issue ids like {form.key || 'WEB'}-12. Auto-filled from the name; edit to customize.</p>
              )}
            </div>
            <Field label="Local git repo path">
              <PathField value={form.repo_path} onChange={(v) => setForm({ ...form, repo_path: v })} />
            </Field>
            <Field label="Default branch">
              <Input value={form.default_branch} onChange={(e) => setForm({ ...form, default_branch: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="Preview command (optional — {port} is substituted)">
                <Input value={form.preview_command} onChange={(e) => setForm({ ...form, preview_command: e.target.value })} placeholder="npm run dev -- --port {port}" />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Project context (optional — appended to every agent prompt)">
                <Textarea rows={3} value={form.context} onChange={(e) => setForm({ ...form, context: e.target.value })} placeholder="Conventions, data model notes, gotchas…" />
              </Field>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
            <Button variant="primary" disabled={!form.name || keyTaken || create.isPending} onClick={() => create.mutate()}>
              Create
            </Button>
          </div>
        </Panel>
      )}

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : projects && projects.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`}>
              <Panel className="h-full p-4 transition hover:border-indigo-500/60">
                <div className="mb-2 flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded text-xs font-bold" style={{ background: p.color + '33', color: p.color }}>
                    {p.key}
                  </span>
                  <span className="font-medium">{p.name}</span>
                </div>
                <p className="mb-3 line-clamp-2 text-xs text-muted">{p.description || 'No description'}</p>
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <FolderGit2 className="h-3.5 w-3.5" />
                  {p.repo_path ? <span className="truncate">{p.repo_path}</span> : <span className="text-amber-500/80">no repo set — agents can't run</span>}
                </div>
              </Panel>
            </Link>
          ))}
        </div>
      ) : (
        <Panel className="p-8 text-center text-sm text-muted">
          No projects yet. Create one and point it at a local git repo to start running agents.
        </Panel>
      )}
    </div>
  );
}
