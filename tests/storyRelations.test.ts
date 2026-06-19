import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue } = await import('../src/server/repo/issues');
const { savePlanContext } = await import('../src/server/repo/planContext');
const { listStoryReferenceContexts } = await import('../src/server/repo/issueRelations');
const { issueRoutes } = await import('../src/server/http/routes/issues');
const { projectRoutes } = await import('../src/server/http/routes/projects');

test.after(() => env.cleanup());

test('creates a follow-up story from a completed story with referenced context', async () => {
  const project = createProject({ name: 'Story Chain', key: 'SCN' });
  const source = createIssue({
    project_id: project.id,
    title: 'Rename custom report',
    status: 'done',
    description: 'The report builder display name was changed from Custom Report to Saved Report.',
    acceptance_criteria: '- Existing saved reports keep working\n- Navigation uses the new name',
  });
  savePlanContext(source.id, {
    context: 'Report naming is centralized in src/reporting/names.ts.',
    key_files: [{ path: 'src/reporting/names.ts', purpose: 'Shared report labels' }],
  });

  const res = await issueRoutes.request(`/${source.id}/follow-ups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Adjust saved report export naming',
      description: 'Update export filenames to match the renamed report experience.',
      acceptance_criteria: '- Exported files use the Saved Report label',
      include_context: true,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { issue: { id: string; key: string }; relation: { context_summary: string | null } };
  assert.ok(body.issue.id);
  assert.match(body.issue.key, /^SCN-\d+$/);
  assert.ok(body.relation.context_summary?.includes('Rename custom report'));
  assert.ok(body.relation.context_summary?.includes('src/reporting/names.ts'));

  const created = getIssue(body.issue.id)!;
  assert.equal(created.project_id, project.id);
  assert.equal(created.status, 'todo');

  const detail = await issueRoutes.request(`/${created.id}`);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    relations: {
      incoming: { source: { id: string; key: string }; target: { id: string }; context_summary: string | null }[];
      outgoing: unknown[];
    };
  };
  assert.equal(detailBody.relations.incoming.length, 1);
  assert.equal(detailBody.relations.incoming[0]?.source.id, source.id);
  assert.equal(detailBody.relations.incoming[0]?.target.id, created.id);
  assert.equal(detailBody.relations.outgoing.length, 0);

  const contexts = listStoryReferenceContexts(created.id);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.source_key, source.key);
  assert.match(contexts[0]?.context_summary ?? '', /Report naming is centralized/);
});

test('GET /api/projects/:id/relations returns the project story-tree edges, 404 when missing', async () => {
  const project = createProject({ name: 'Story Tree', key: 'STR' });
  const root = createIssue({ project_id: project.id, title: 'Build the importer', status: 'done' });
  const followUp = await issueRoutes.request(`/${root.id}/follow-ups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Harden importer error handling', include_context: false }),
  });
  assert.equal(followUp.status, 201);
  const { issue: child } = (await followUp.json()) as { issue: { id: string } };

  const res = await projectRoutes.request(`/${project.id}/relations`);
  assert.equal(res.status, 200);
  const relations = (await res.json()) as {
    type: string;
    source: { id: string };
    target: { id: string };
  }[];
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.type, 'follow_up');
  assert.equal(relations[0]?.source.id, root.id);
  assert.equal(relations[0]?.target.id, child.id);

  // Relations are scoped to the project — a second project sees none of the first project's edges.
  const other = createProject({ name: 'Empty Tree', key: 'EMT' });
  const otherRes = await projectRoutes.request(`/${other.id}/relations`);
  assert.equal(otherRes.status, 200);
  assert.deepEqual(await otherRes.json(), []);

  const missing = await projectRoutes.request('/does-not-exist/relations');
  assert.equal(missing.status, 404);
});

test('rejects follow-up creation from an unfinished story', async () => {
  const project = createProject({ name: 'Story Chain Guard', key: 'SCG' });
  const source = createIssue({
    project_id: project.id,
    title: 'Rename report column',
    status: 'review',
  });

  const res = await issueRoutes.request(`/${source.id}/follow-ups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Follow-up should wait' }),
  });
  assert.equal(res.status, 409);
});
