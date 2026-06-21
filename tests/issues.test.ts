import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue, updateIssue } = await import('../src/server/repo/issues');
const { getDb } = await import('../src/server/db/client');

test.after(() => env.cleanup());

test('issue.thinking_effort round-trips through create and clears/sets via update (SYM-46)', () => {
  const project = createProject({ name: 'Thinking', key: 'THK' });

  // Created without the field ⇒ NULL = inherit.
  const inherit = createIssue({ project_id: project.id, title: 'inherits' });
  assert.equal(inherit.thinking_effort, null);

  // Created with an explicit keyword ⇒ persisted verbatim.
  const created = createIssue({ project_id: project.id, title: 'thinks', thinking_effort: 'think-hard' });
  assert.equal(created.thinking_effort, 'think-hard');
  assert.equal(getIssue(created.id)!.thinking_effort, 'think-hard');

  // Update to a different keyword.
  assert.equal(updateIssue(created.id, { thinking_effort: 'ultrathink' })!.thinking_effort, 'ultrathink');

  // Update to null clears it back to inherit (the generic UPDATABLE loop writes null).
  assert.equal(updateIssue(created.id, { thinking_effort: null })!.thinking_effort, null);
  assert.equal(getIssue(created.id)!.thinking_effort, null);
});

test('mapRow coerces a garbage thinking_effort value to null (SYM-46 defensive boundary)', () => {
  const project = createProject({ name: 'Garbage', key: 'GBG' });
  const issue = createIssue({ project_id: project.id, title: 'garbage in' });

  // Write a value past the typed input layer, directly to the column.
  getDb().prepare(`UPDATE issues SET thinking_effort = 'megathink' WHERE id = ?`).run(issue.id);

  // mapRow only lets a whitelisted keyword through; anything else reads back as null (= inherit).
  assert.equal(getIssue(issue.id)!.thinking_effort, null);
});

test('issue.enable_workflow_tool round-trips through create and clears/sets via update (SYM-67)', () => {
  const project = createProject({ name: 'Workflow', key: 'WFL' });

  // Created without the field ⇒ NULL = inherit.
  const inherit = createIssue({ project_id: project.id, title: 'inherits' });
  assert.equal(inherit.enable_workflow_tool, null);

  // Created with an explicit boolean ⇒ persisted as 0/1, read back as a boolean.
  const on = createIssue({ project_id: project.id, title: 'opts in', enable_workflow_tool: true });
  assert.equal(on.enable_workflow_tool, true);
  assert.equal(getIssue(on.id)!.enable_workflow_tool, true);

  const off = createIssue({ project_id: project.id, title: 'opts out', enable_workflow_tool: false });
  assert.equal(off.enable_workflow_tool, false);
  assert.equal(getIssue(off.id)!.enable_workflow_tool, false);

  // Update flips the boolean (the dedicated branch binds 0/1, never a JS boolean — node:sqlite rejects those).
  assert.equal(updateIssue(on.id, { enable_workflow_tool: false })!.enable_workflow_tool, false);

  // Update to null clears it back to inherit (must round-trip as a real NULL, not 0).
  assert.equal(updateIssue(on.id, { enable_workflow_tool: null })!.enable_workflow_tool, null);
  assert.equal(getIssue(on.id)!.enable_workflow_tool, null);
});

test('mapRow maps the enable_workflow_tool 0/1/NULL column boundary (SYM-67)', () => {
  const project = createProject({ name: 'WF Boundary', key: 'WFB' });
  const issue = createIssue({ project_id: project.id, title: 'boundary' });
  const db = getDb();

  db.prepare(`UPDATE issues SET enable_workflow_tool = 1 WHERE id = ?`).run(issue.id);
  assert.equal(getIssue(issue.id)!.enable_workflow_tool, true);

  db.prepare(`UPDATE issues SET enable_workflow_tool = 0 WHERE id = ?`).run(issue.id);
  assert.equal(getIssue(issue.id)!.enable_workflow_tool, false);

  db.prepare(`UPDATE issues SET enable_workflow_tool = NULL WHERE id = ?`).run(issue.id);
  assert.equal(getIssue(issue.id)!.enable_workflow_tool, null);
});

test('issue.source/source_run_id default to manual/null and round-trip an explicit review origin (SYM-78)', () => {
  const project = createProject({ name: 'Provenance', key: 'PRV' });

  // Created without provenance ⇒ the system default 'manual' with no run pointer.
  const manual = createIssue({ project_id: project.id, title: 'hand-made' });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.source_run_id, null);

  // The review-convert routes pass these explicitly; they persist verbatim.
  const fromReview = createIssue({
    project_id: project.id,
    title: 'from a review',
    source: 'review',
    source_run_id: 'run-123',
  });
  assert.equal(fromReview.source, 'review');
  assert.equal(fromReview.source_run_id, 'run-123');
  assert.equal(getIssue(fromReview.id)!.source, 'review');
  assert.equal(getIssue(fromReview.id)!.source_run_id, 'run-123');
});

test('mapRow coerces a garbage source value to manual (SYM-78 defensive boundary)', () => {
  const project = createProject({ name: 'Garbage Source', key: 'GBS' });
  const issue = createIssue({ project_id: project.id, title: 'garbage in', source: 'review', source_run_id: 'r1' });

  // Write a value past the typed input layer, directly to the column.
  getDb().prepare(`UPDATE issues SET source = 'wat' WHERE id = ?`).run(issue.id);

  // mapRow only lets a whitelisted source through; anything else reads back as 'manual'.
  assert.equal(getIssue(issue.id)!.source, 'manual');
  // The soft pointer is untouched — it is not whitelisted, just passed through.
  assert.equal(getIssue(issue.id)!.source_run_id, 'r1');
});

test('updateIssue cannot change source/source_run_id — provenance is immutable (SYM-78)', () => {
  const project = createProject({ name: 'Immutable', key: 'IMU' });
  const issue = createIssue({ project_id: project.id, title: 'manual', source: 'manual' });

  // source/source_run_id are absent from UPDATABLE, so a PATCH-style update silently ignores them.
  const updated = updateIssue(issue.id, {
    title: 'renamed',
    // @ts-expect-error — UpdateIssueInput intentionally has no source fields; assert they're ignored.
    source: 'review',
    source_run_id: 'spoofed',
  })!;
  assert.equal(updated.title, 'renamed'); // the legit field still applied
  assert.equal(updated.source, 'manual'); // provenance unchanged
  assert.equal(updated.source_run_id, null);
});
