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
