import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue } = await import('../src/server/repo/issues');
const { getPreview, startPreview, stopPreview, stopAllPreviews } = await import(
  '../src/server/preview/manager'
);

test.after(() => {
  stopAllPreviews();
  env.cleanup();
});

test('a preview command that dies at boot reports the failure instead of a dead URL', async () => {
  const project = createProject({ name: 'Preview', key: 'PV', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Broken preview', status: 'review' });

  const status = await startPreview(issue.id, env.repoPath, 'echo boom && exit 7');
  assert.equal(status.running, false);
  assert.match(status.error ?? '', /exited \(code 7\)/);
  assert.match(status.error ?? '', /boom/);

  // The failure stays visible on subsequent status polls (the UI shows it).
  const polled = getPreview(issue.id);
  assert.equal(polled.running, false);
  assert.match(polled.error ?? '', /exited \(code 7\)/);
});

test('a long-lived preview process reports running and can be stopped', async () => {
  const project = createProject({ name: 'Preview OK', key: 'PO', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Healthy preview', status: 'review' });

  const status = await startPreview(issue.id, env.repoPath, 'node -e "setTimeout(() => {}, 10000)"');
  assert.equal(status.running, true);
  assert.ok(status.url?.startsWith('http://localhost:'), 'expected a localhost URL');

  assert.equal(stopPreview(issue.id), true);
  assert.equal(getPreview(issue.id).running, false);
});
