import { useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderPlus,
  Github,
  Package,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ProjectSkill, ProjectSkillSource } from '../../shared/types';
import { api } from '../api';
import { ProjectTabs } from '../components/ProjectTabs';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Panel,
  ProjectChip,
  Select,
  Skeleton,
  Textarea,
} from '../components/ui';
import { SKILL_SOURCE_META } from '../lib/format';

// SYM-63: the Skills tab is redesigned around scanning a *large* set. The list became a dense,
// responsive card grid with a search / source / status / sort toolbar (mirrors Ops' HistoryPanel), the
// add-source panels are tucked behind one collapsed "Add skills" disclosure so the grid is the primary
// content, and create/edit both live in a focus-trapping Modal. No server, schema, or API change —
// the same GET /api/projects/:id/skills feeds an in-memory useMemo filter/sort.
// SYM-64: a header "Sync to projects" action (SyncSkillsModal) layers on top — copy this project's
// skills into other projects in one push.

interface SkillForm {
  name: string;
  description: string;
  content: string;
}

const EMPTY_FORM: SkillForm = { name: '', description: '', content: '' };

type StatusFilter = 'all' | 'enabled' | 'disabled';
type SortKey = 'recent' | 'name';

export function ProjectSkills() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const projectId = id!;

  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.projects.get(projectId) });
  const { data: skills, isLoading } = useQuery({
    queryKey: ['project-skills', projectId],
    queryFn: () => api.projects.skills.list(projectId),
  });

  // Add-source affordances (collapsed by default so the list leads).
  const [showAdd, setShowAdd] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [installCommand, setInstallCommand] = useState('');

  // Modals: create a new skill, or edit an existing one (by id).
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingSkill = skills?.find((s) => s.id === editingId) ?? null;
  // SYM-64: the "Sync to projects" modal (copy skills into other projects).
  const [syncing, setSyncing] = useState(false);

  // Toolbar: search + source + status filters, sort key + direction. Default order matches the
  // server's created_at DESC so the redesign preserves the prior list ordering until the user re-sorts.
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | ProjectSkillSource>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [desc, setDesc] = useState(true);

  const filtersActive = search.trim() !== '' || sourceFilter !== 'all' || statusFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setSourceFilter('all');
    setStatusFilter('all');
  };

  const filtered = useMemo(() => {
    const list = skills ?? [];
    const q = search.trim().toLowerCase();
    const out = list.filter((s) => {
      if (sourceFilter !== 'all' && s.source !== sourceFilter) return false;
      if (statusFilter === 'enabled' && !s.enabled) return false;
      if (statusFilter === 'disabled' && s.enabled) return false;
      if (q && !s.name.toLowerCase().includes(q) && !(s.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    const cmp = (a: ProjectSkill, b: ProjectSkill): number =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return [...out].sort((a, b) => (desc ? -1 : 1) * cmp(a, b));
  }, [skills, search, sourceFilter, statusFilter, sort, desc]);

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
    mutationFn: (form: SkillForm) =>
      api.projects.skills.create(projectId, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        content: form.content,
      }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      toast.success('Skill created');
    },
    onError: (e) => toast.error(String(e)),
  });

  const updateSkill = useMutation({
    mutationFn: (vars: { id: string; form: SkillForm }) =>
      api.projects.skills.update(projectId, vars.id, {
        name: vars.form.name.trim(),
        description: vars.form.description.trim() || null,
        content: vars.form.content,
      }),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      toast.success('Skill saved');
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

  if (!project) return <Loading />;

  const count = skills?.length ?? 0;

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        back={{ to: '/' }}
        icon={<ProjectChip color={project.color}>{project.key}</ProjectChip>}
        title={project.name}
        actions={
          <>
            <Button
              onClick={() => setSyncing(true)}
              disabled={!skills || skills.length === 0}
              title={!skills || skills.length === 0 ? 'Add a skill before syncing' : undefined}
            >
              <Copy className="h-4 w-4" /> Sync to projects
            </Button>
            <Button
              variant="primary"
              onClick={() => setShowAdd((v) => !v)}
              aria-expanded={showAdd}
              aria-controls="add-skills-region"
            >
              <Plus className="h-4 w-4" /> Add skills
              {showAdd ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </>
        }
      />

      <ProjectTabs projectId={project.id} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-5 pb-10">
          {showAdd && (
            <div id="add-skills-region" className="mx-auto w-full max-w-3xl space-y-4">
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
                      aria-label="GitHub skill URL"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && importUrl.trim() && !importSkill.isPending) importSkill.mutate();
                      }}
                    />
                  </div>
                  <Button
                    variant="primary"
                    disabled={!importUrl.trim() || importSkill.isPending}
                    onClick={() => importSkill.mutate()}
                  >
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
                  aria-label="Claude Code install commands"
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

              <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-fg">
                  <Sparkles className="h-4 w-4 text-amber-300" /> Create manually
                  <span className="text-xs font-normal text-muted">Write a SKILL.md by hand.</span>
                </div>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> New skill
                </Button>
              </Panel>
            </div>
          )}

          <div className="mx-auto w-full max-w-6xl space-y-4">
            {isLoading ? (
              <SkeletonGrid />
            ) : count === 0 ? (
              <EmptyState
                icon={<Sparkles />}
                title="No skills yet"
                description="Import one from GitHub or create your own — enabled skills are loaded into every agent run."
                action={
                  <Button variant="primary" onClick={() => setShowAdd(true)}>
                    <Plus className="h-4 w-4" /> Add skills
                  </Button>
                }
              />
            ) : (
              <>
                <Toolbar
                  search={search}
                  onSearch={setSearch}
                  sourceFilter={sourceFilter}
                  onSource={setSourceFilter}
                  statusFilter={statusFilter}
                  onStatus={setStatusFilter}
                  sort={sort}
                  onSort={setSort}
                  desc={desc}
                  onToggleDesc={() => setDesc((d) => !d)}
                  shown={filtered.length}
                  total={count}
                  filtersActive={filtersActive}
                  onClear={clearFilters}
                />

                {filtered.length === 0 ? (
                  <EmptyState
                    icon={<Search />}
                    title="No skills match these filters"
                    description="Try a different search term, or clear the filters to see everything."
                    action={<Button onClick={clearFilters}>Clear filters</Button>}
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((skill) => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        onEdit={() => setEditingId(skill.id)}
                        onToggle={() => toggleSkill.mutate(skill)}
                        toggling={toggleSkill.isPending && toggleSkill.variables?.id === skill.id}
                        onDelete={() => {
                          if (confirm(`Delete skill “${skill.name}”?`)) removeSkill.mutate(skill.id);
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {creating && (
        <SkillFormModal
          key="create"
          title="New skill"
          icon={<Sparkles className="h-4 w-4 text-amber-300" />}
          initial={EMPTY_FORM}
          submitLabel="Create"
          submitIcon={<Plus className="h-4 w-4" />}
          pending={createSkill.isPending}
          onSubmit={(form) => createSkill.mutate(form)}
          onClose={() => setCreating(false)}
        />
      )}

      {editingSkill && (
        <SkillFormModal
          key={editingSkill.id}
          title="Edit skill"
          icon={<Pencil className="h-4 w-4 text-indigo-300" />}
          initial={{
            name: editingSkill.name,
            description: editingSkill.description ?? '',
            content: editingSkill.content,
          }}
          submitLabel="Save"
          submitIcon={<Save className="h-4 w-4" />}
          pending={updateSkill.isPending}
          onSubmit={(form) => updateSkill.mutate({ id: editingSkill.id, form })}
          onClose={() => setEditingId(null)}
        />
      )}

      {syncing && skills && skills.length > 0 && (
        <SyncSkillsModal projectId={projectId} skills={skills} onClose={() => setSyncing(false)} />
      )}
    </div>
  );
}

function Toolbar({
  search,
  onSearch,
  sourceFilter,
  onSource,
  statusFilter,
  onStatus,
  sort,
  onSort,
  desc,
  onToggleDesc,
  shown,
  total,
  filtersActive,
  onClear,
}: {
  search: string;
  onSearch: (v: string) => void;
  sourceFilter: 'all' | ProjectSkillSource;
  onSource: (v: 'all' | ProjectSkillSource) => void;
  statusFilter: StatusFilter;
  onStatus: (v: StatusFilter) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  desc: boolean;
  onToggleDesc: () => void;
  shown: number;
  total: number;
  filtersActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills by name or description"
          className="w-48 pl-8"
        />
      </div>
      <Select
        value={sourceFilter}
        onChange={(e) => onSource(e.target.value as 'all' | ProjectSkillSource)}
        aria-label="Filter by source"
        className="w-auto"
      >
        <option value="all">All sources</option>
        {(Object.keys(SKILL_SOURCE_META) as ProjectSkillSource[]).map((s) => (
          <option key={s} value={s}>
            {SKILL_SOURCE_META[s].label}
          </option>
        ))}
      </Select>
      <Select
        value={statusFilter}
        onChange={(e) => onStatus(e.target.value as StatusFilter)}
        aria-label="Filter by status"
        className="w-auto"
      >
        <option value="all">All statuses</option>
        <option value="enabled">Enabled</option>
        <option value="disabled">Disabled</option>
      </Select>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-muted" aria-live="polite">
          {shown === total ? `${total} skill${total === 1 ? '' : 's'}` : `${shown} of ${total}`}
        </span>
        {filtersActive && (
          <Button size="sm" onClick={onClear}>
            Clear
          </Button>
        )}
        <Select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} aria-label="Sort by" className="w-auto">
          <option value="recent">Recent</option>
          <option value="name">Name</option>
        </Select>
        <Button onClick={onToggleDesc} title="Toggle sort direction" aria-label="Toggle sort direction">
          {desc ? '↓ Desc' : '↑ Asc'}
        </Button>
      </div>
    </div>
  );
}

/**
 * SYM-64: "Sync skills to projects" — pick target projects + skills and copy them in one push. The
 * source list is unchanged (each copy is a fresh row in the target); name collisions in a target are
 * reported as skips. A separate component so its selection state resets on every open (fresh mount).
 */
function SyncSkillsModal({
  projectId,
  skills,
  onClose,
}: {
  projectId: string;
  skills: ProjectSkill[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Gate the projects fetch on the modal being open (this component only mounts while open).
  const { data: projects, isLoading } = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const otherProjects = (projects ?? []).filter((p) => p.id !== projectId);

  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  // Default to copying every skill — the common case is "push them all to the other project".
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(() => new Set(skills.map((s) => s.id)));

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const copy = useMutation({
    mutationFn: () =>
      api.projects.skills.copy(projectId, {
        target_project_ids: [...selectedTargets],
        skill_ids: [...selectedSkills],
      }),
    onSuccess: (result) => {
      // The source list is unchanged; refresh each target's cache so a later visit shows the copies.
      for (const t of selectedTargets) qc.invalidateQueries({ queryKey: ['project-skills', t] });
      const imported = result.results.reduce((n, r) => n + r.imported.length, 0);
      const skippedCount = result.results.reduce((n, r) => n + r.skipped.length, 0);
      const into = result.results.filter((r) => r.imported.length > 0).length;
      const summary = `Copied ${imported} skill${imported === 1 ? '' : 's'} to ${into} project${into === 1 ? '' : 's'}`;
      toast.success(
        skippedCount ? `${summary} · skipped ${skippedCount} duplicate${skippedCount === 1 ? '' : 's'}` : summary,
      );
      onClose();
    },
    onError: (e) => toast.error(String(e)),
  });

  const canCopy = selectedTargets.size > 0 && selectedSkills.size > 0 && !copy.isPending;

  return (
    <Modal
      title="Sync skills to projects"
      icon={<Copy className="h-4 w-4" />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={copy.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={copy.isPending} disabled={!canCopy} onClick={() => copy.mutate()}>
            <Copy className="h-4 w-4" /> Copy
          </Button>
        </>
      }
    >
      {isLoading ? (
        <Loading />
      ) : otherProjects.length === 0 ? (
        <EmptyState
          icon={<FolderPlus />}
          title="No other projects"
          description="Create another project first — skills are pushed into the projects you pick here."
        />
      ) : (
        <div className="space-y-5">
          <section>
            <div className="mb-2 text-xs font-medium text-muted">
              Copy to ({selectedTargets.size}/{otherProjects.length})
            </div>
            <div className="space-y-1">
              {otherProjects.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2"
                >
                  <input
                    type="checkbox"
                    className="accent-indigo-500"
                    checked={selectedTargets.has(p.id)}
                    onChange={() => setSelectedTargets((s) => toggle(s, p.id))}
                  />
                  <ProjectChip color={p.color}>{p.key}</ProjectChip>
                  <span className="truncate text-sm">{p.name}</span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 text-xs font-medium text-muted">
              Skills ({selectedSkills.size}/{skills.length})
            </div>
            <div className="space-y-1">
              {skills.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2"
                >
                  <input
                    type="checkbox"
                    className="accent-indigo-500"
                    checked={selectedSkills.has(skill.id)}
                    onChange={() => setSelectedSkills((s) => toggle(s, skill.id))}
                  />
                  <span className="truncate text-sm">{skill.name}</span>
                  {!skill.enabled && <Badge className="bg-amber-500/15 text-amber-400">disabled</Badge>}
                </label>
              ))}
            </div>
          </section>

          <p className="text-xs text-muted">
            Copies are new skills in each target (provenance preserved); this project's skills are unchanged.
            A skill whose name already exists in a target is skipped.
          </p>
        </div>
      )}
    </Modal>
  );
}

function SkillCard({
  skill,
  onEdit,
  onToggle,
  toggling,
  onDelete,
}: {
  skill: ProjectSkill;
  onEdit: () => void;
  onToggle: () => void;
  toggling: boolean;
  onDelete: () => void;
}) {
  const source = SKILL_SOURCE_META[skill.source];
  return (
    <Panel interactive className={cn('flex h-full flex-col gap-2 p-3', !skill.enabled && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-fg" title={skill.name}>
          {skill.name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Badge className={source.badge}>{source.label}</Badge>
          {!skill.enabled && <Badge className="bg-amber-500/15 text-amber-400">disabled</Badge>}
        </div>
      </div>

      <p className="line-clamp-2 text-xs text-muted">{skill.description || 'No description'}</p>

      {skill.source_url && (
        <a
          href={skill.source_url}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-[11px] text-indigo-400 hover:underline"
          title={skill.source_url}
        >
          {skill.source_url}
        </a>
      )}

      <div className="mt-auto flex items-center gap-1 pt-1">
        <Button size="sm" onClick={onToggle} disabled={toggling}>
          {skill.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="sm" aria-label={`Edit ${skill.name}`} className="justify-center px-2" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="danger"
          aria-label={`Delete ${skill.name}`}
          className="ml-auto justify-center px-2"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </Panel>
  );
}

function SkillFormModal({
  title,
  icon,
  initial,
  submitLabel,
  submitIcon,
  pending,
  onSubmit,
  onClose,
}: {
  title: string;
  icon: ReactNode;
  initial: SkillForm;
  submitLabel: string;
  submitIcon: ReactNode;
  pending: boolean;
  onSubmit: (form: SkillForm) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SkillForm>(initial);
  const valid = form.name.trim().length > 0;
  return (
    <Modal
      onClose={onClose}
      title={title}
      icon={icon}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid || pending} onClick={() => onSubmit(form)}>
            {submitIcon} {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="commit-message-style"
          />
        </Field>
        <Field label="Description">
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="When and how to use this skill (shown to the agent)"
          />
        </Field>
        <Field label="SKILL.md content">
          <Textarea
            rows={12}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            placeholder={'Instructions the agent should follow…\n\n(YAML front matter is added automatically.)'}
          />
        </Field>
      </div>
    </Modal>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-32" />
      ))}
    </div>
  );
}
