import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Download, Github, Package, Pencil, Plus, Save, Sparkles, Trash2, X } from 'lucide-react';
import type { ProjectSkill } from '../../shared/types';
import { api } from '../api';
import { ProjectTabs } from '../components/ProjectTabs';
import { Badge, Button, Field, Input, Panel, Textarea } from '../components/ui';

interface SkillForm {
  name: string;
  description: string;
  content: string;
}

const EMPTY_FORM: SkillForm = { name: '', description: '', content: '' };

const sourceBadgeClass = (source: ProjectSkill['source']) =>
  source === 'github'
    ? 'bg-indigo-500/15 text-indigo-300'
    : source === 'marketplace'
      ? 'bg-emerald-500/15 text-emerald-300'
      : 'bg-panel-2 text-muted';

export function ProjectSkills() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const projectId = id!;

  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.projects.get(projectId) });
  const { data: skills, isLoading } = useQuery({
    queryKey: ['project-skills', projectId],
    queryFn: () => api.projects.skills.list(projectId),
  });

  const [importUrl, setImportUrl] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<SkillForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['project-skills', projectId] });

  const importSkill = useMutation({
    mutationFn: () => api.projects.skills.import(projectId, importUrl.trim()),
    // SYM-58: a bare repo URL can import several skills, so mirror the install batch toast.
    onSuccess: (result) => {
      invalidate();
      setImportUrl('');
      const imported = result.imported.length;
      const summary = `Imported ${imported} skill${imported === 1 ? '' : 's'}`;
      if (result.skipped.length) {
        toast.success(`${summary} · skipped ${result.skipped.length} (${result.skipped.map((s) => s.name).join(', ')})`);
      } else {
        toast.success(summary);
      }
    },
    onError: (e) => toast.error(String(e)),
  });

  const installSkills = useMutation({
    mutationFn: () => api.projects.skills.install(projectId, installCommand.trim()),
    onSuccess: (result) => {
      invalidate();
      setInstallCommand('');
      const imported = result.imported.length;
      const summary = `Imported ${imported} skill${imported === 1 ? '' : 's'}`;
      if (result.skipped.length) {
        toast.success(`${summary} · skipped ${result.skipped.length} (${result.skipped.map((s) => s.name).join(', ')})`);
      } else {
        toast.success(summary);
      }
    },
    onError: (e) => toast.error(String(e)),
  });

  const createSkill = useMutation({
    mutationFn: () =>
      api.projects.skills.create(projectId, {
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        content: createForm.content,
      }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setCreateForm(EMPTY_FORM);
      toast.success('Skill created');
    },
    onError: (e) => toast.error(String(e)),
  });

  const toggleSkill = useMutation({
    mutationFn: (skill: ProjectSkill) => api.projects.skills.update(projectId, skill.id, { enabled: !skill.enabled }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(String(e)),
  });

  const removeSkill = useMutation({
    mutationFn: (skillId: string) => api.projects.skills.remove(projectId, skillId),
    onSuccess: () => {
      invalidate();
      toast.success('Skill deleted');
    },
    onError: (e) => toast.error(String(e)),
  });

  if (!project) return <div className="p-8 text-sm text-muted">Loading…</div>;

  return (
    <div className="flex h-full flex-col p-6">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="grid h-7 w-7 place-items-center rounded text-xs font-bold" style={{ background: project.color + '33', color: project.color }}>
            {project.key}
          </span>
          <h1 className="text-lg font-semibold">{project.name}</h1>
        </div>
        <Button variant="primary" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" /> New skill
        </Button>
      </header>

      <ProjectTabs projectId={project.id} />

      <div className="mx-auto w-full max-w-3xl space-y-4 pb-8">
        <Panel className="p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-fg">
            <Github className="h-4 w-4 text-indigo-300" /> Import from GitHub
          </div>
          <p className="mb-3 text-xs text-muted">
            Paste a link to a skill's <code>SKILL.md</code> (or its folder) on GitHub — a <code>blob</code>,{' '}
            <code>tree</code>, or <code>raw</code> URL. A bare repo URL like{' '}
            <code>github.com/owner/repo</code> works too: its default branch is resolved and every{' '}
            <code>SKILL.md</code> at the repo root, directly under <code>skills/</code>, or in{' '}
            <code>skills/&lt;name&gt;/</code> subfolders is imported.
          </p>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <Input
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && importUrl.trim() && !importSkill.isPending) importSkill.mutate();
                }}
              />
            </div>
            <Button variant="primary" disabled={!importUrl.trim() || importSkill.isPending} onClick={() => importSkill.mutate()}>
              <Download className="h-4 w-4" /> Import
            </Button>
          </div>
        </Panel>

        <Panel className="p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-fg">
            <Package className="h-4 w-4 text-emerald-300" /> Install from Claude Code
          </div>
          <p className="mb-3 text-xs text-muted">
            Paste the <code>/plugin</code> commands a marketplace prints (the <code>marketplace add</code> and{' '}
            <code>install</code> lines) — every skill the plugin ships is imported. An <code>owner/repo</code> or
            GitHub repo URL works too.
          </p>
          <Textarea
            rows={3}
            className="font-mono text-xs"
            value={installCommand}
            onChange={(e) => setInstallCommand(e.target.value)}
            placeholder={'/plugin marketplace add owner/repo\n/plugin install my-plugin@my-marketplace'}
          />
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              disabled={!installCommand.trim() || installSkills.isPending}
              onClick={() => installSkills.mutate()}
            >
              <Package className="h-4 w-4" /> {installSkills.isPending ? 'Installing…' : 'Install'}
            </Button>
          </div>
        </Panel>

        {creating && (
          <Panel className="p-4">
            <div className="mb-3 text-sm font-medium text-fg">New skill</div>
            <div className="space-y-3">
              <Field label="Name">
                <Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="commit-message-style" />
              </Field>
              <Field label="Description">
                <Input
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  placeholder="When and how to use this skill (shown to the agent)"
                />
              </Field>
              <Field label="SKILL.md content">
                <Textarea
                  rows={10}
                  value={createForm.content}
                  onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })}
                  placeholder={'Instructions the agent should follow…\n\n(YAML front matter is added automatically.)'}
                />
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => { setCreating(false); setCreateForm(EMPTY_FORM); }}>Cancel</Button>
              <Button variant="primary" disabled={!createForm.name.trim() || createSkill.isPending} onClick={() => createSkill.mutate()}>
                <Plus className="h-4 w-4" /> Create
              </Button>
            </div>
          </Panel>
        )}

        {isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : skills && skills.length > 0 ? (
          <div className="space-y-3">
            {skills.map((skill) =>
              editingId === skill.id ? (
                <SkillEditor
                  key={skill.id}
                  projectId={projectId}
                  skill={skill}
                  onClose={() => setEditingId(null)}
                  onSaved={() => { invalidate(); setEditingId(null); }}
                />
              ) : (
                <Panel key={skill.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{skill.name}</span>
                        <Badge className={sourceBadgeClass(skill.source)}>{skill.source}</Badge>
                        {!skill.enabled && <Badge className="bg-amber-500/15 text-amber-400">disabled</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{skill.description || 'No description'}</p>
                      {skill.source_url && (
                        <a href={skill.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block truncate text-[11px] text-indigo-400 hover:underline">
                          {skill.source_url}
                        </a>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button onClick={() => toggleSkill.mutate(skill)} disabled={toggleSkill.isPending}>
                        {skill.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button aria-label="Edit skill" className="justify-center px-2" onClick={() => setEditingId(skill.id)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="danger"
                        aria-label="Delete skill"
                        className="justify-center px-2"
                        onClick={() => {
                          if (confirm(`Delete skill “${skill.name}”?`)) removeSkill.mutate(skill.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Panel>
              ),
            )}
          </div>
        ) : (
          <Panel className="p-8 text-center text-sm text-muted">
            <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted" />
            No skills yet. Import one from GitHub or create your own — enabled skills are loaded into every agent run.
          </Panel>
        )}
      </div>
    </div>
  );
}

function SkillEditor({
  projectId,
  skill,
  onClose,
  onSaved,
}: {
  projectId: string;
  skill: ProjectSkill;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SkillForm>({
    name: skill.name,
    description: skill.description ?? '',
    content: skill.content,
  });
  const save = useMutation({
    mutationFn: () =>
      api.projects.skills.update(projectId, skill.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        content: form.content,
      }),
    onSuccess: () => {
      onSaved();
      toast.success('Skill saved');
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Edit skill</div>
        <Button aria-label="Cancel edit" className="justify-center px-2" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-3">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="SKILL.md content">
          <Textarea rows={10} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
          <Save className="h-4 w-4" /> Save
        </Button>
      </div>
    </Panel>
  );
}
