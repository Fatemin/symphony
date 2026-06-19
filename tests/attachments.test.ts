import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';
import { makeFakeRunner } from './helpers/fakeRunner';
import type { AgentResult, AgentRunInput, AgentRunner } from '../src/server/agent/types';

// Env must be set before importing any server module (they read paths from env at import). SYM-35:
// ATTACHMENTS_DIR derives from SYMPHONY_DATA_DIR, which setupEnv now points at the throwaway dir, so
// every attachment blob is isolated per test run.
const env = setupEnv();

const { ATTACHMENTS_DIR } = await import('../src/server/env');
const { createProject } = await import('../src/server/repo/projects');
const { createIssue, getIssue, deleteIssue } = await import('../src/server/repo/issues');
const attachments = await import('../src/server/repo/attachments');
const { getConfig } = await import('../src/server/repo/settings');
const { attachmentRoutes } = await import('../src/server/http/routes/attachments');
const { issueRoutes } = await import('../src/server/http/routes/issues');
const { askRoutes, runProjectAsk } = await import('../src/server/http/routes/ask');
const { appendAskTurn, listTodaysAskMessages } = await import('../src/server/repo/ask');
const { runIssuePipeline } = await import('../src/server/phases/index');
const { getDb } = await import('../src/server/db/client');

test.after(() => env.cleanup());

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, num_turns: 1 };

/** A canned agent reply that captures the input it was given, for prompt assertions. */
function fakeRunner(text: string, sink?: { input?: AgentRunInput }): AgentRunner {
  return async (input) => {
    if (sink) sink.input = input;
    return { ok: true, sessionId: 'att-sess', text, usage, durationMs: 1 } as AgentResult;
  };
}

// ── repo: storage round-trip + path-traversal safety ─────────────────────────

test('createAttachment stores a blob and reads it back, linked to an issue', () => {
  const project = createProject({ name: 'Att Repo', key: 'AR', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Has files', status: 'todo' });
  const bytes = Buffer.from('PNG-bytes-数据', 'utf8');

  const att = attachments.createAttachment({
    project_id: project.id,
    issue_id: issue.id,
    filename: 'shot.png',
    mime: 'image/png',
    bytes,
  });
  assert.equal(att.filename, 'shot.png');
  assert.equal(att.size_bytes, bytes.byteLength);
  assert.equal(att.issue_id, issue.id);

  // getAttachment + readAttachment round-trip the exact bytes.
  assert.equal(attachments.getAttachment(att.id)?.id, att.id);
  const read = attachments.readAttachment(att.id);
  assert.ok(read);
  assert.deepEqual(read!.bytes, bytes);
  assert.equal(read!.attachment.mime, 'image/png');

  // listByIssue returns it; the prompt ref exposes an absolute path inside ATTACHMENTS_DIR.
  assert.equal(attachments.listAttachmentsByIssue(issue.id).length, 1);
  const refs = attachments.listAttachmentRefsByIssue(issue.id);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.filename, 'shot.png');
  assert.ok(refs[0]!.path.startsWith(path.resolve(ATTACHMENTS_DIR)));
  assert.ok(fs.existsSync(refs[0]!.path));
});

test('linkAttachmentsToIssue adopts an unlinked upload', () => {
  const project = createProject({ name: 'Att Link', key: 'AL', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Link later', status: 'todo' });
  const att = attachments.createAttachment({
    project_id: project.id,
    filename: 'f.txt',
    mime: 'text/plain',
    bytes: Buffer.from('hi'),
  });
  assert.equal(att.issue_id, null);

  attachments.linkAttachmentsToIssue([att.id], issue.id);
  assert.equal(attachments.getAttachment(att.id)?.issue_id, issue.id);
  assert.equal(attachments.countAttachmentsForIssue(issue.id), 1);
});

test('a filename with traversal is sanitized to a safe path segment on disk', () => {
  const project = createProject({ name: 'Att Trav', key: 'AT', repo_path: env.repoPath });
  const att = attachments.createAttachment({
    project_id: project.id,
    filename: '../../etc/passwd',
    mime: 'text/plain',
    bytes: Buffer.from('x'),
  });
  // Stored safely and still readable; the blob never escapes ATTACHMENTS_DIR.
  assert.ok(attachments.readAttachment(att.id));
  const ref = attachments.listAttachmentRefsByIds([att.id])[0]!;
  assert.ok(ref.path.startsWith(path.resolve(ATTACHMENTS_DIR)));
  assert.ok(!ref.path.includes('etc/passwd'));
});

test('readAttachment refuses a row whose storage_path escapes the attachments root', () => {
  const project = createProject({ name: 'Att Escape', key: 'AE', repo_path: env.repoPath });
  const id = 'evil-row';
  getDb()
    .prepare(
      `INSERT INTO attachments (id, project_id, filename, mime, size_bytes, storage_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, project.id, 'passwd', 'text/plain', 1, '../../../../etc/passwd');
  assert.equal(attachments.readAttachment(id), null, 'an escaping storage_path is treated as missing');
  assert.equal(attachments.listAttachmentRefsByIds([id]).length, 0, 'and is dropped from prompt refs');
});

// ── HTTP: upload / serve / delete + guards ───────────────────────────────────

test('POST /api/attachments uploads a file and GET serves its bytes', async () => {
  const project = createProject({ name: 'Up', key: 'UP', repo_path: env.repoPath });

  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', { type: 'image/png' }));
  form.append('project_id', project.id);
  const res = await attachmentRoutes.request('/', { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const att = (await res.json()) as { id: string; filename: string; size_bytes: number };
  assert.equal(att.filename, 'pic.png');
  assert.equal(att.size_bytes, 4);

  // The bytes serve back inline with the right content-type.
  const serve = await attachmentRoutes.request(`/${att.id}`);
  assert.equal(serve.status, 200);
  assert.equal(serve.headers.get('content-type'), 'image/png');
  assert.match(serve.headers.get('content-disposition') ?? '', /^inline/);
  assert.deepEqual(new Uint8Array(await serve.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  // ?download=1 flips the disposition to attachment.
  const dl = await attachmentRoutes.request(`/${att.id}?download=1`);
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment/);
});

test('POST /api/attachments validates the file, the project, and the size', async () => {
  const project = createProject({ name: 'Up Bad', key: 'UB', repo_path: env.repoPath });

  // Missing file → 400.
  const noFile = new FormData();
  noFile.append('project_id', project.id);
  assert.equal((await attachmentRoutes.request('/', { method: 'POST', body: noFile })).status, 400);

  // Missing project_id → 400.
  const noProj = new FormData();
  noProj.append('file', new File([new Uint8Array([1])], 'a.bin'));
  assert.equal((await attachmentRoutes.request('/', { method: 'POST', body: noProj })).status, 400);

  // Unknown project_id → 400.
  const badProj = new FormData();
  badProj.append('file', new File([new Uint8Array([1])], 'a.bin'));
  badProj.append('project_id', 'does-not-exist');
  assert.equal((await attachmentRoutes.request('/', { method: 'POST', body: badProj })).status, 400);

  // Over the size limit → 413.
  const big = new FormData();
  big.append('file', new File([new Uint8Array(getConfig().max_attachment_bytes + 1)], 'big.bin'));
  big.append('project_id', project.id);
  assert.equal((await attachmentRoutes.request('/', { method: 'POST', body: big })).status, 413);

  // Unknown attachment id → 404.
  assert.equal((await attachmentRoutes.request('/nope')).status, 404);
});

test('per-item count limits are enforced on link and on a pre-linked upload', async () => {
  const project = createProject({ name: 'Cap', key: 'CAP', repo_path: env.repoPath });
  const max = getConfig().max_attachments_per_item;

  // Issue create with too many attachment_ids → 400 (the cap is checked before any linking).
  const tooMany = Array.from({ length: max + 1 }, (_, i) => `id-${i}`);
  const res = await issueRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: project.id, title: 'Too many', attachment_ids: tooMany }),
  });
  assert.equal(res.status, 400);

  // An upload pre-linked to an already-full issue → 400.
  const issue = createIssue({ project_id: project.id, title: 'Fill up', status: 'todo' });
  for (let i = 0; i < max; i++) {
    attachments.createAttachment({
      project_id: project.id,
      issue_id: issue.id,
      filename: `f${i}.txt`,
      mime: 'text/plain',
      bytes: Buffer.from('x'),
    });
  }
  const over = new FormData();
  over.append('file', new File([new Uint8Array([1])], 'over.txt', { type: 'text/plain' }));
  over.append('project_id', project.id);
  over.append('issue_id', issue.id);
  assert.equal((await attachmentRoutes.request('/', { method: 'POST', body: over })).status, 400);
});

test('DELETE /api/attachments/:id removes the blob and the row', async () => {
  const project = createProject({ name: 'Del', key: 'DL', repo_path: env.repoPath });
  const att = attachments.createAttachment({
    project_id: project.id,
    filename: 'gone.txt',
    mime: 'text/plain',
    bytes: Buffer.from('bye'),
  });
  const refPath = attachments.listAttachmentRefsByIds([att.id])[0]!.path;
  assert.ok(fs.existsSync(refPath));

  const res = await attachmentRoutes.request(`/${att.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(attachments.getAttachment(att.id), null);
  assert.ok(!fs.existsSync(refPath), 'the blob is removed too');
});

// ── issues: link on create, return on detail, reclaim blobs on delete ─────────

test('createIssue links attachment_ids, detail returns them, deleteIssue reclaims blobs', async () => {
  const project = createProject({ name: 'Detail', key: 'DT', repo_path: env.repoPath });
  const a1 = attachments.createAttachment({ project_id: project.id, filename: 'one.png', mime: 'image/png', bytes: Buffer.from('1') });
  const a2 = attachments.createAttachment({ project_id: project.id, filename: 'two.txt', mime: 'text/plain', bytes: Buffer.from('2') });

  const issue = createIssue({ project_id: project.id, title: 'With files', status: 'todo', attachment_ids: [a1.id, a2.id] });
  assert.equal(attachments.countAttachmentsForIssue(issue.id), 2);

  // GET /:id detail includes the attachments.
  const detail = (await (await issueRoutes.request(`/${issue.id}`)).json()) as { attachments: { id: string }[] };
  assert.equal(detail.attachments.length, 2);

  // Blobs exist on disk; deleteIssue reclaims them (the FK cascade would only drop the rows).
  const refs = attachments.listAttachmentRefsByIssue(issue.id);
  assert.ok(refs.every((r) => fs.existsSync(r.path)));
  deleteIssue(issue.id);
  assert.equal(getIssue(issue.id), null);
  assert.equal(attachments.getAttachment(a1.id), null);
  assert.ok(refs.every((r) => !fs.existsSync(r.path)), 'blobs are removed when the issue is deleted');
});

// ── prompt threading: pipeline + ask ─────────────────────────────────────────

test('pipeline threads issue attachments into every phase prompt', async () => {
  const project = createProject({ name: 'Pipe Att', key: 'PA', repo_path: env.repoPath });
  const issue = createIssue({ project_id: project.id, title: 'Read my screenshot', status: 'todo', mode: 'auto' });
  attachments.createAttachment({
    project_id: project.id,
    issue_id: issue.id,
    filename: 'mock.png',
    mime: 'image/png',
    bytes: Buffer.from('imgbytes'),
  });
  const expectedPath = attachments.listAttachmentRefsByIssue(issue.id)[0]!.path;

  const inputs: AgentRunInput[] = [];
  const result = await runIssuePipeline(issue.id, {
    runner: makeFakeRunner({ qa: 'pass', inputs }),
    config: getConfig(),
  });
  assert.equal(result.ok, true);
  assert.equal(inputs.length, 4, 'plan, implement, qa, delivery each ran once');
  for (const input of inputs) {
    assert.match(input.prompt, /## Attachments/);
    assert.ok(input.prompt.includes('mock.png'), 'each phase prompt names the attachment');
    assert.ok(input.prompt.includes(expectedPath), 'each phase prompt carries the absolute Read path');
  }
});

test('runProjectAsk renders attached files in the prompt', async () => {
  const project = createProject({ name: 'Ask Att', key: 'AA', repo_path: env.repoPath });
  const att = attachments.createAttachment({ project_id: project.id, filename: 'diagram.png', mime: 'image/png', bytes: Buffer.from('d') });
  const refPath = attachments.listAttachmentRefsByIds([att.id])[0]!.path;

  const sink: { input?: AgentRunInput } = {};
  const res = await runProjectAsk(
    project,
    { question: 'What does this show?', attachment_ids: [att.id] },
    { runner: fakeRunner('Looks like a flow chart.', sink), config: getConfig() },
  );
  assert.ok(res.answer.includes('flow chart'));
  assert.match(sink.input!.prompt, /## Attached files/);
  assert.ok(sink.input!.prompt.includes('diagram.png'));
  assert.ok(sink.input!.prompt.includes(refPath));
});

test('an ask turn persists its attachment links so reload re-displays them', () => {
  const project = createProject({ name: 'Ask Persist', key: 'AKP', repo_path: env.repoPath });
  const att = attachments.createAttachment({ project_id: project.id, filename: 'note.txt', mime: 'text/plain', bytes: Buffer.from('n') });

  appendAskTurn(project.id, 'user', 'see attached', null, [att.id]);
  appendAskTurn(project.id, 'assistant', 'noted');

  const messages = listTodaysAskMessages(project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.attachments?.length, 1);
  assert.equal(messages[0]!.attachments?.[0]!.id, att.id);
  assert.equal(messages[1]!.attachments, undefined, 'the assistant turn carries no attachments');
});

test('POST /:id/ask rejects too many attachments without invoking the agent', async () => {
  const project = createProject({ name: 'Ask Cap', key: 'AKC', repo_path: env.repoPath });
  const tooMany = Array.from({ length: getConfig().max_attachments_per_item + 1 }, (_, i) => `x${i}`);
  const res = await askRoutes.request(`/${project.id}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'hi', attachment_ids: tooMany }),
  });
  assert.equal(res.status, 400);
});
