import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Link2, Network } from 'lucide-react';
import { api } from '../api';
import { ProjectTabs } from '../components/ProjectTabs';
import { Badge, EmptyState, ErrorState, Loading, PageHeader, ProjectChip } from '../components/ui';
import { PRIORITY_META, STATUS_META } from '../lib/format';
import { buildStoryTrees, type StoryTreeNode } from '../lib/storyTree';

export function StoryTree() {
  const { id } = useParams<{ id: string }>();
  const projectId = id!;

  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.projects.get(projectId) });
  const {
    data: relations,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['project-relations', projectId],
    queryFn: () => api.projects.relations(projectId),
    // Stories sprout follow-ups while the orchestrator runs — keep the tree fresh like the Board.
    refetchInterval: 5_000,
  });

  if (!project) return <Loading />;

  const trees = relations ? buildStoryTrees(relations) : [];

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        back={{ to: '/' }}
        icon={<ProjectChip color={project.color}>{project.key}</ProjectChip>}
        title={project.name}
      />

      <ProjectTabs projectId={project.id} />

      <div className="mx-auto w-full max-w-3xl pb-8">
        <div className="mb-4 flex items-center gap-2 text-sm text-muted">
          <Network className="h-4 w-4 text-indigo-300" />
          <p>
            Issues linked by a story chain — a <span className="text-fg">follow-up</span> nests under the story that
            spawned it, while <span className="text-fg">related</span> issues are shown as cross-links.
          </p>
        </div>

        {isLoading ? (
          <Loading />
        ) : isError ? (
          <ErrorState
            title="Couldn't load the story tree"
            description={error instanceof Error ? error.message : undefined}
          />
        ) : trees.length > 0 ? (
          <ul className="space-y-3">
            {trees.map((node) => (
              <li key={node.issue.id}>
                <StoryNode node={node} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Network />}
            title="No story trees yet"
            description="When an issue spawns a follow-up or is linked to another, the chain shows up here."
          />
        )}
      </div>
    </div>
  );
}

function StoryNode({ node }: { node: StoryTreeNode }) {
  return (
    <div>
      <StoryRow node={node} />
      {node.children.length > 0 && (
        // Children nest beneath their parent with a guide rail, mirroring the story chain on IssueDetail.
        <ul className="mt-2 space-y-2 border-l border-border pl-4">
          {node.children.map((child) => (
            <li key={child.issue.id}>
              <StoryNode node={child} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StoryRow({ node }: { node: StoryTreeNode }) {
  const { issue, relation, related } = node;
  const meta = STATUS_META[issue.status];
  return (
    <div className="rounded-md border border-border bg-bg-2 px-3 py-2">
      <Link to={`/issues/${issue.id}`} className="block min-w-0 hover:text-indigo-300">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted">{issue.key}</span>
          <span className={`inline-flex items-center gap-1 ${meta.color}`}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} /> {meta.label}
          </span>
          {relation && <Badge className="bg-indigo-500/10 text-indigo-300">follow-up</Badge>}
          {issue.priority > 0 && (
            <span className={`ml-auto text-[10px] ${PRIORITY_META[issue.priority].color}`}>
              {PRIORITY_META[issue.priority].label}
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-sm text-fg">{issue.title}</p>
      </Link>

      {related.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <Link2 className="h-3 w-3 text-muted" />
          {related.map(({ issue: other }) => (
            <Link
              key={other.id}
              to={`/issues/${other.id}`}
              className="inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-muted hover:text-fg"
            >
              <span className="font-mono">{other.key}</span>
              <span className="max-w-[14rem] truncate">{other.title}</span>
            </Link>
          ))}
        </div>
      )}

      {relation?.context_summary && (
        <details className="mt-2">
          <summary className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted hover:text-fg">
            <GitBranch className="h-3 w-3" /> Referenced context
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 font-mono text-[11px] leading-relaxed text-muted">
            {relation.context_summary}
          </pre>
        </details>
      )}
    </div>
  );
}
