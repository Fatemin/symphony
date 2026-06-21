import type { BoardIssue, IssueType } from '../../shared/types';
import { ISSUE_SOURCE_META, ISSUE_TYPE_META } from './format';

// SYM-78: the board's "Group by" axes. 'status' is rendered by the kanban itself (byte-for-byte the
// pre-existing layout); only 'source' / 'type' fold into the swimlane groups this helper builds.
export type BoardGroupBy = 'status' | 'source' | 'type';

/** One swimlane: a stable key (for collapse state + React keys), a header label, and its issues. */
export interface BoardGroup {
  key: string;
  label: string;
  issues: BoardIssue[];
}

// Fixed display order for the "by type" axis — the project's `按功能` (by feature/kind) grouping.
const TYPE_ORDER: IssueType[] = ['feature', 'bug', 'chore', 'epic'];

/**
 * Fold a board's issues into ordered swimlane groups for the Group-by axis (SYM-78). Pure — no React
 * runtime, so it is unit-testable from a node:test.
 *
 * - `source` (`按来源`): one group per review batch (key = `source_run_id`) plus a single catch-all
 *   per non-review origin (key = the literal `source`, e.g. 'manual'). The label is the server-derived
 *   `source_label` ('Review · <scope>') when present, else the generic `ISSUE_SOURCE_META[source].label`
 *   fallback (so a deleted review run still reads as 'Review' while its issues stay grouped by the
 *   surviving `source_run_id`). Review batches lead, ordered by their newest member's `created_at`
 *   (most recent first); the non-review catch-all(s) sort last.
 * - `type` (`按功能`): one group per issue type in the fixed [feature, bug, chore, epic] order; empty
 *   types are dropped.
 */
export function groupIssues(issues: BoardIssue[], by: Exclude<BoardGroupBy, 'status'>): BoardGroup[] {
  if (by === 'type') {
    return TYPE_ORDER.map((type) => ({
      key: type,
      label: ISSUE_TYPE_META[type].label,
      issues: issues.filter((i) => i.type === type),
    })).filter((g) => g.issues.length > 0);
  }

  // by === 'source': bucket by the originating review run, falling back to the bare source value for
  // non-review issues so every manual issue lands in one shared 'Manual' group.
  const groups = new Map<string, BoardGroup>();
  for (const issue of issues) {
    const key = issue.source_run_id ?? issue.source;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: issue.source_label ?? ISSUE_SOURCE_META[issue.source].label,
        issues: [],
      };
      groups.set(key, group);
    }
    group.issues.push(issue);
  }

  const newest = (g: BoardGroup) =>
    g.issues.reduce((max, i) => (i.created_at > max ? i.created_at : max), '');
  const isReviewBatch = (g: BoardGroup) => g.issues.some((i) => i.source_run_id);
  return [...groups.values()].sort((a, b) => {
    const aBatch = isReviewBatch(a);
    const bBatch = isReviewBatch(b);
    if (aBatch !== bBatch) return aBatch ? -1 : 1; // review batches before the catch-all(s)
    if (!aBatch) return 0; // stable order among non-review catch-alls (manual / ask)
    return newest(b).localeCompare(newest(a)); // ISO timestamps sort lexically → newest batch first
  });
}
