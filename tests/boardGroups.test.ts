import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardIssue } from '../src/shared/types';

// SYM-78: groupIssues is a PURE web helper (type-only shared imports + the format.ts constants, no
// React runtime), so it is importable and assertable straight from a node:test — kept fully offline.
const { groupIssues } = await import('../src/web/lib/boardGroups');

const BASE: BoardIssue = {
  id: 'base',
  project_id: 'p1',
  parent_id: null,
  key: 'P-0',
  type: 'feature',
  title: 'base',
  description: null,
  acceptance_criteria: null,
  labels: [],
  priority: 0,
  status: 'todo',
  mode: 'manual',
  thinking_effort: null,
  enable_workflow_tool: null,
  require_review: true,
  base_branch: null,
  branch_name: null,
  worktree_path: null,
  round: 1,
  merge_conflict: null,
  source: 'manual',
  source_run_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  current_phase: null,
  source_label: null,
};
const mk = (over: Partial<BoardIssue> & Pick<BoardIssue, 'id'>): BoardIssue => ({ ...BASE, ...over });

test('groupIssues(source) buckets review batches by run, newest batch first, manual catch-all last', () => {
  const issues = [
    // The manual issue is the newest of all, but a catch-all always sorts after the review batches.
    mk({ id: 'm1', source: 'manual', created_at: '2026-03-01T00:00:00.000Z' }),
    mk({ id: 'a1', source: 'review', source_run_id: 'runA', source_label: 'Review · Code', created_at: '2026-01-01T00:00:00.000Z' }),
    mk({ id: 'a2', source: 'review', source_run_id: 'runA', source_label: 'Review · Code', created_at: '2026-01-05T00:00:00.000Z' }),
    mk({ id: 'b1', source: 'review', source_run_id: 'runB', source_label: 'Review · Docs', created_at: '2026-02-01T00:00:00.000Z' }),
  ];
  const groups = groupIssues(issues, 'source');

  // runB's newest member (Feb) beats runA's (Jan 5) → runB first; manual last despite its March date.
  assert.deepEqual(groups.map((g) => g.key), ['runB', 'runA', 'manual']);
  assert.deepEqual(groups.map((g) => g.label), ['Review · Docs', 'Review · Code', 'Manual']);
  assert.equal(groups[1]!.issues.length, 2); // runA has both a1 + a2
});

test('groupIssues(source) keeps a deleted run grouped under a generic "Review" fallback label', () => {
  // source_label is null (the run was deleted server-side) but source_run_id survives, so the issues
  // still group together — under the generic ISSUE_SOURCE_META.review label.
  const issues = [
    mk({ id: 'd1', source: 'review', source_run_id: 'gone', source_label: null, created_at: '2026-01-01T00:00:00.000Z' }),
    mk({ id: 'd2', source: 'review', source_run_id: 'gone', source_label: null, created_at: '2026-01-02T00:00:00.000Z' }),
  ];
  const groups = groupIssues(issues, 'source');
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.key, 'gone');
  assert.equal(groups[0]!.label, 'Review');
  assert.equal(groups[0]!.issues.length, 2);
});

test('groupIssues(type) orders feature→bug→chore→epic and drops empty types', () => {
  const issues = [
    mk({ id: 'c1', type: 'chore' }),
    mk({ id: 'f1', type: 'feature' }),
    mk({ id: 'b1', type: 'bug' }),
    mk({ id: 'f2', type: 'feature' }),
  ];
  const groups = groupIssues(issues, 'type');
  // epic has no members and is dropped; the rest keep the fixed axis order.
  assert.deepEqual(groups.map((g) => g.key), ['feature', 'bug', 'chore']);
  assert.deepEqual(groups.map((g) => g.label), ['Feature', 'Bug', 'Chore']);
  assert.equal(groups[0]!.issues.length, 2);
});

test('groupIssues returns no groups for an empty board', () => {
  assert.deepEqual(groupIssues([], 'source'), []);
  assert.deepEqual(groupIssues([], 'type'), []);
});
