import type { IssueLink, IssueRelation } from '../../shared/types';

/**
 * Story Tree model (SYM-30). The server hands us a flat list of a project's issue relations; this
 * folds them into a forest:
 *   - `follow_up` edges nest source → target (the source story produced the target story).
 *   - `relates_to` edges are undirected cross-links, surfaced on the node rather than as nesting.
 * Only issues that appear in some relation get a node, so the forest IS the "has a story tree" view.
 */
export interface StoryTreeNode {
  issue: IssueLink;
  /** The `follow_up` relation that links this node to its parent (carries context_summary); null at a root. */
  relation: IssueRelation | null;
  /** `follow_up` descendants — stories this issue produced. */
  children: StoryTreeNode[];
  /** `relates_to` cross-links to issues elsewhere in the project. */
  related: RelatedLink[];
}

export interface RelatedLink {
  relation: IssueRelation;
  issue: IssueLink;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Oldest story first; key as a stable tiebreaker so the forest order is deterministic. */
function byCreatedThenKey(a: IssueLink, b: IssueLink): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function buildStoryTrees(relations: IssueRelation[]): StoryTreeNode[] {
  const links = new Map<string, IssueLink>();
  const followChildren = new Map<string, IssueRelation[]>(); // parent id → follow_up relations
  const followTargets = new Set<string>(); // any issue that is the target of a follow_up
  const relatesByIssue = new Map<string, IssueRelation[]>(); // issue id → relates_to relations it's in

  for (const rel of relations) {
    links.set(rel.source.id, rel.source);
    links.set(rel.target.id, rel.target);
    if (rel.type === 'follow_up') {
      pushTo(followChildren, rel.source_issue_id, rel);
      followTargets.add(rel.target_issue_id);
    } else {
      pushTo(relatesByIssue, rel.source_issue_id, rel);
      pushTo(relatesByIssue, rel.target_issue_id, rel);
    }
  }

  // A node renders once, anywhere — the visited set guarantees termination even if follow_up edges
  // ever cycle (A→B→A) and keeps a multi-parent target from spawning duplicate subtrees.
  const visited = new Set<string>();

  const build = (issue: IssueLink, relation: IssueRelation | null): StoryTreeNode => {
    visited.add(issue.id);
    const children: StoryTreeNode[] = [];
    for (const childRel of followChildren.get(issue.id) ?? []) {
      if (visited.has(childRel.target_issue_id)) continue;
      children.push(build(childRel.target, childRel));
    }
    const related: RelatedLink[] = [];
    const seen = new Set<string>();
    for (const rel of relatesByIssue.get(issue.id) ?? []) {
      const other = rel.source_issue_id === issue.id ? rel.target : rel.source;
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      related.push({ relation: rel, issue: other });
    }
    return { issue, relation, children, related };
  };

  const roots: StoryTreeNode[] = [];
  // Roots are issues that are never produced by a follow_up (includes relates_to-only stories).
  for (const link of [...links.values()].filter((l) => !followTargets.has(l.id)).sort(byCreatedThenKey)) {
    if (!visited.has(link.id)) roots.push(build(link, null));
  }
  // Any issue still unvisited sits in a follow_up cycle or under an already-placed parent — surface
  // it as its own root so the tab never silently drops a story.
  for (const link of [...links.values()].filter((l) => !visited.has(l.id)).sort(byCreatedThenKey)) {
    if (!visited.has(link.id)) roots.push(build(link, null));
  }
  return roots;
}
