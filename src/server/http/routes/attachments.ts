import { Hono } from 'hono';
import {
  countAttachmentsForIssue,
  createAttachment,
  deleteAttachment,
  readAttachment,
} from '../../repo/attachments';
import { getIssue } from '../../repo/issues';
import { getProject } from '../../repo/projects';
import { getConfig } from '../../repo/settings';

// Attachment transport (SYM-35). Binary in/out uses multipart + raw bytes — NOT base64-in-JSON —
// to avoid 33% inflation. Upload is a separate step from issue/ask create: the client uploads each
// file as it is pasted/dropped and holds the returned id; issue/ask create then carry attachment_ids
// (small JSON) which the server links. An upload may pre-link to an issue (issue_id) when one exists
// already (the edit flow); the new-issue/ask flows upload unlinked and link on submit.

export const attachmentRoutes = new Hono();

// POST /api/attachments — multipart upload of one file. Fields: file (required), project_id
// (required), issue_id (optional, auto-links + enforces the per-issue cap).
attachmentRoutes.post('/', async (c) => {
  const cfg = getConfig();

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data with a file field' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  if (file.size <= 0) return c.json({ error: 'file is empty' }, 400);
  if (file.size > cfg.max_attachment_bytes) {
    return c.json({ error: `file too large — max ${cfg.max_attachment_bytes} bytes` }, 413);
  }

  const projectId = strField(form.get('project_id'));
  if (!projectId) return c.json({ error: 'project_id is required' }, 400);
  if (!getProject(projectId)) return c.json({ error: 'project not found' }, 400);

  const issueId = strField(form.get('issue_id'));
  if (issueId) {
    const issue = getIssue(issueId);
    if (!issue) return c.json({ error: 'issue not found' }, 400);
    if (issue.project_id !== projectId) {
      return c.json({ error: 'issue does not belong to project' }, 400);
    }
    if (countAttachmentsForIssue(issueId) >= cfg.max_attachments_per_item) {
      return c.json({ error: `too many attachments (max ${cfg.max_attachments_per_item})` }, 400);
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const attachment = createAttachment({
    project_id: projectId,
    issue_id: issueId ?? null,
    filename: file.name,
    mime: file.type,
    bytes,
  });
  return c.json(attachment, 201);
});

// GET /api/attachments/:id — serve the raw bytes (inline for previews; ?download=1 forces download).
attachmentRoutes.get('/:id', (c) => {
  const found = readAttachment(c.req.param('id'));
  if (!found) return c.json({ error: 'not found' }, 404);
  const { attachment, bytes } = found;
  const disposition = c.req.query('download') ? 'attachment' : 'inline';
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': attachment.mime || 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      // Private (these can be sensitive) but cacheable — the bytes for an id never change.
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

// DELETE /api/attachments/:id — drop the blob + row (used by the remove (X) action). Idempotent.
attachmentRoutes.delete('/:id', (c) => {
  deleteAttachment(c.req.param('id'));
  return c.body(null, 204);
});

/** Pull a trimmed non-empty string out of a multipart field (FormData values are File | string). */
function strField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
