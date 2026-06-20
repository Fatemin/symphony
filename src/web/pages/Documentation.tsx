import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, FileCode, FileText, Plus, RotateCcw, X } from 'lucide-react';
import type { DocEntry, Project } from '../../shared/types';
import { api, type ProjectWorkflowConfig } from '../api';
import { ProjectTabs } from '../components/ProjectTabs';
import { Markdown } from '../components/Markdown';
import { Button, EmptyState, ErrorState, Input, Loading, PageHeader, Panel, ProjectChip, Spinner } from '../components/ui';

const DEFAULT_DOC_DIRECTORIES = ['docs'];
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;
const CODE_RE = /\.(json|ya?ml)$/i;

export function Documentation() {
  const { id } = useParams<{ id: string }>();
  const projectId = id!;
  const qc = useQueryClient();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId),
  });

  const {
    data: listing,
    isLoading: listLoading,
    isError: listError,
    error: listErr,
  } = useQuery({
    // Docs change rarely (and only via this page) — no aggressive refetch interval, unlike the Board.
    queryKey: ['project-docs', projectId],
    queryFn: () => api.projects.docs(projectId),
    enabled: !!project?.repo_path,
  });

  const [selected, setSelected] = useState<string | null>(null);

  // Auto-select the first doc once the listing lands (preferring a README), and recover when the
  // selected file disappears (e.g. a directory was removed) by falling back to the new first entry.
  useEffect(() => {
    const files = listing?.files;
    if (!files || files.length === 0) {
      setSelected(null);
      return;
    }
    if (selected && files.some((f) => f.path === selected)) return;
    const readme = files.find((f) => /^readme\.(md|markdown|mdx|txt)$/i.test(f.name));
    const target = readme ?? files[0];
    if (target) setSelected(target.path);
  }, [listing, selected]);

  const {
    data: doc,
    isLoading: docLoading,
    isError: docError,
    error: docErr,
  } = useQuery({
    queryKey: ['project-doc', projectId, selected],
    queryFn: () => api.projects.docContent(projectId, selected!),
    enabled: !!selected,
  });

  const saveDirs = useMutation({
    // The config blob is replaced wholesale on save, so spread the current config and override only
    // `docs` — otherwise every other section (agent/prompts/verification/…) would reset to defaults.
    mutationFn: (directories: string[]) =>
      api.projects.update(projectId, {
        config: { ...currentConfig(project), docs: { directories } } as unknown,
      } as Partial<Project>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['project-docs', projectId] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const directories = listing?.directories ?? DEFAULT_DOC_DIRECTORIES;
  const groups = useMemo(() => groupByDir(listing?.files ?? [], directories), [listing, directories]);

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
        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
          <aside className="flex shrink-0 flex-col gap-3 lg:w-72">
            <DirectoryEditor
              directories={directories}
              saving={saveDirs.isPending}
              onChange={(dirs) => saveDirs.mutate(dirs)}
            />
            <Panel className="min-h-0 flex-1 overflow-y-auto p-2">
              {listLoading ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted">
                  <Spinner /> Loading documents…
                </div>
              ) : listError ? (
                <p className="p-3 text-sm text-red-400">
                  Couldn't load documents{listErr instanceof Error ? `: ${listErr.message}` : ''}.
                </p>
              ) : groups.length === 0 ? (
                <p className="p-3 text-sm text-muted">No documents found.</p>
              ) : (
                <nav className="space-y-3">
                  {groups.map((group) => (
                    <div key={group.dir}>
                      <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                        {group.dir}
                      </p>
                      <ul className="space-y-0.5">
                        {group.files.map((file) => (
                          <li key={file.path}>
                            <FileButton
                              file={file}
                              dir={group.dir}
                              selected={selected === file.path}
                              onSelect={() => setSelected(file.path)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </nav>
              )}
            </Panel>
          </aside>

          <section className="min-h-0 flex-1 overflow-y-auto">
            <ReadingPane
              hasFiles={(listing?.files.length ?? 0) > 0}
              listLoading={listLoading}
              directories={directories}
              selected={selected}
              doc={doc}
              docLoading={docLoading}
              docError={docError}
              docErr={docErr}
            />
          </section>
        </div>
      )}
    </div>
  );
}

function ReadingPane({
  hasFiles,
  listLoading,
  directories,
  selected,
  doc,
  docLoading,
  docError,
  docErr,
}: {
  hasFiles: boolean;
  listLoading: boolean;
  directories: string[];
  selected: string | null;
  doc: { name: string; content: string } | undefined;
  docLoading: boolean;
  docError: boolean;
  docErr: unknown;
}) {
  if (listLoading) {
    return <Loading />;
  }
  if (!hasFiles) {
    return (
      <EmptyState
        className="mx-auto mt-8 max-w-md"
        icon={<BookOpen />}
        title="No documents found"
        description={`Looked in ${directories.length ? directories.map((d) => `“${d}”`).join(', ') : 'the configured directories'}. Add a directory above, or drop Markdown files into one of these folders.`}
      />
    );
  }
  if (!selected) {
    return <p className="p-8 text-sm text-muted">Select a document to read.</p>;
  }
  if (docLoading) {
    return <Loading />;
  }
  if (docError || !doc) {
    return (
      <ErrorState
        className="mx-auto mt-8 max-w-md"
        title="Couldn't open this document"
        description={docErr instanceof Error ? docErr.message : undefined}
      />
    );
  }
  return (
    <article className="mx-auto max-w-3xl pb-12">
      <h2 className="mb-4 flex items-center gap-2 border-b border-border pb-3 text-sm font-medium text-fg">
        {MARKDOWN_RE.test(doc.name) ? (
          <FileText className="h-4 w-4 text-indigo-300" />
        ) : (
          <FileCode className="h-4 w-4 text-indigo-300" />
        )}
        <span className="font-mono text-muted">{selected}</span>
      </h2>
      {MARKDOWN_RE.test(doc.name) ? (
        <Markdown source={doc.content} />
      ) : (
        <pre className="overflow-x-auto rounded-md border border-border bg-bg-2 p-3 text-xs leading-relaxed text-fg">
          {doc.content}
        </pre>
      )}
    </article>
  );
}

function FileButton({
  file,
  dir,
  selected,
  onSelect,
}: {
  file: DocEntry;
  dir: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = CODE_RE.test(file.name) ? FileCode : FileText;
  // Show the path relative to its configured directory so nested files stay distinguishable.
  const label = file.path.startsWith(`${dir}/`) ? file.path.slice(dir.length + 1) : file.name;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        selected ? 'bg-indigo-500/15 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg'
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-indigo-300' : ''}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function DirectoryEditor({
  directories,
  saving,
  onChange,
}: {
  directories: string[];
  saving: boolean;
  onChange: (dirs: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const next = draft.trim().replace(/^[/\\]+|[/\\]+$/g, '');
    if (!next) return;
    if (directories.includes(next)) {
      setDraft('');
      return;
    }
    onChange([...directories, next]);
    setDraft('');
  };

  const remove = (dir: string) => onChange(directories.filter((d) => d !== dir));
  const isDefault = directories.length === 1 && directories[0] === DEFAULT_DOC_DIRECTORIES[0];

  return (
    <Panel className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Source directories</span>
        {saving && <Spinner />}
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {directories.length === 0 && <span className="text-xs text-muted">No directories — add one below.</span>}
        {directories.map((dir) => (
          <span
            key={dir}
            className="inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-fg"
          >
            {dir}
            <button
              type="button"
              aria-label={`Remove ${dir}`}
              onClick={() => remove(dir)}
              disabled={saving}
              className="rounded text-muted transition hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add directory, e.g. guides"
          disabled={saving}
          className="py-1 text-xs"
        />
        <Button type="submit" aria-label="Add directory" disabled={saving || !draft.trim()} className="shrink-0 px-2 py-1">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </form>
      {!isDefault && (
        <button
          type="button"
          onClick={() => onChange([...DEFAULT_DOC_DIRECTORIES])}
          disabled={saving}
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" /> Reset to default (docs)
        </button>
      )}
    </Panel>
  );
}

function NoRepo() {
  return (
    <div className="mx-auto mt-10 w-full max-w-md">
      <EmptyState
        icon={<BookOpen />}
        title="No linked repo"
        description="This project has no linked repo, so there are no documents to show. Link a repository in the Agent settings to read its docs here."
      />
    </div>
  );
}

interface DirGroup {
  dir: string;
  files: DocEntry[];
}

/** Group the flat file list by its configured directory, preserving the configured order. */
function groupByDir(files: DocEntry[], directories: string[]): DirGroup[] {
  const byDir = new Map<string, DocEntry[]>();
  for (const file of files) {
    const list = byDir.get(file.dir) ?? [];
    list.push(file);
    byDir.set(file.dir, list);
  }
  const groups: DirGroup[] = [];
  for (const dir of directories) {
    const list = byDir.get(dir);
    if (list && list.length) groups.push({ dir, files: list });
  }
  // Any group not matching a configured directory (shouldn't happen) lands at the end.
  for (const [dir, list] of byDir) {
    if (!directories.includes(dir)) groups.push({ dir, files: list });
  }
  return groups;
}

/** The project's current config as a plain object to spread when patching (server re-merges it). */
function currentConfig(project: Project | undefined): ProjectWorkflowConfig | Record<string, unknown> {
  const config = project?.config;
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
}
