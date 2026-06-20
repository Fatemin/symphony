import { Hono } from 'hono';
import type { AgentType, AskHistory, AskMessage, AskResponse, Project } from '../../../shared/types';
import type { EngineConfig } from '../../core/config';
import { buildAskPrompt, parseAsk } from '../../core/prompt';
import { mergeProjectConfigs } from '../../core/projectConfig';
import { loadWorkflow } from '../../core/workflow';
import { runAgent } from '../../agent/runAgent';
import type { AgentRunner } from '../../agent/types';
import { appendAskTurn, listTodaysAskMessages, resetTodaysAsk, todaysAskDate } from '../../repo/ask';
import { listAttachmentRefsByIds } from '../../repo/attachments';
import { getProject } from '../../repo/projects';
import { getConfig } from '../../repo/settings';

// "Ask" is a conversational, READ-ONLY Q&A about a project's repository. Unlike the build pipeline
// it runs against the project's real repo (not an isolated worktree), so the agent is pinned to a
// read-only permission mode and never edits/commits. It is synchronous request/response — no run
// rows, no orchestrator — and may end by drafting a feature/bug for the user to one-click create.

export const askRoutes = new Hono();

/** Bound a Q&A session: ample to read the repo, far below the build pipeline's caps. */
const ASK_MAX_TURNS = 40;

export interface AskRequest {
  question: string;
  history?: AskMessage[];
  /** Optionally run a specific agent CLI; defaults to the project's configured agent. */
  agent?: AgentType;
  /** Ids of previously-uploaded attachments to make Read-able for this turn (SYM-35). */
  attachment_ids?: string[];
}

export interface RunAskOptions {
  /** Injected for tests; production uses the real multi-CLI dispatcher. */
  runner?: AgentRunner;
  config?: EngineConfig;
}

/**
 * Run one ask turn end to end and return the parsed answer (+ optional draft issue). Throws when
 * the project has no repo or the agent run fails, so the caller maps the error to an HTTP status.
 */
export async function runProjectAsk(
  project: Project,
  req: AskRequest,
  opts: RunAskOptions = {},
): Promise<AskResponse> {
  if (!project.repo_path) {
    throw new Error('project has no repo_path — connect a repo before asking');
  }
  const question = req.question.trim();
  if (!question) throw new Error('question is required');

  const runner = opts.runner ?? runAgent;
  const config = opts.config ?? getConfig();
  const workflow = loadWorkflow(project.repo_path);
  // Precedence mirrors phases/types.ts#agentInput: request override → WORKFLOW.md → project → engine.
  const rawAgent = req.agent ?? workflow?.agent ?? project.agent ?? config.agent;
  const agent: AgentType = rawAgent === 'codex' ? 'codex' : 'claude';
  const model =
    workflow?.model ||
    project.model?.trim() ||
    (agent === 'codex' ? config.codex_model : config.model);

  // SYM-35: resolve any attached files to absolute Read-able paths for the prompt.
  const attachments = listAttachmentRefsByIds(req.attachment_ids ?? []);

  // SYM-48 invariant: this run is intentionally NOT cancellable from the HTTP request. Do not thread
  // an AbortSignal (e.g. the route's `c.req.raw.signal`) into the runner input — a client disconnect
  // (the user closing the Ask panel before the reply lands) must NOT abort the in-flight reply. The
  // answer is produced regardless and persisted on completion by the route handler, so a reopen
  // reseeds it from GET /ask/history.
  const result = await runner({
    agent,
    cwd: project.repo_path,
    prompt: buildAskPrompt(project, req.history ?? [], question, attachments),
    systemPrompt:
      'You are Symphony Ask — answer questions about this project READ-ONLY. Never modify, create, ' +
      'or delete files, never commit, and never use interactive prompts.',
    model,
    permissionMode: 'plan', // read-only: the agent explores and answers, it does not edit
    maxTurns: Math.min(config.max_turns, ASK_MAX_TURNS),
    disableWorkflows: true, // SYM-41: Ask never needs the Workflow tool; stay default-off
    timeoutMs: config.phase_timeout_ms,
    cliPath: agent === 'codex' ? config.codex_cli_path : config.cli_path,
  });

  if (!result.ok) throw new Error(result.error ?? 'ask agent failed');

  const { answer, suggestion } = parseAsk(result.text);
  return { answer, session_id: result.sessionId, suggestion };
}

askRoutes.post('/:id/ask', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!project.repo_path) {
    return c.json({ error: 'project has no repo_path — connect a repo before asking' }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    question?: unknown;
    history?: unknown;
    agent?: unknown;
    attachment_ids?: unknown;
  };
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return c.json({ error: 'question is required' }, 400);

  const attachmentIds = normalizeAttachmentIds(body.attachment_ids);
  const maxPerItem = getConfig().max_attachments_per_item;
  if (attachmentIds.length > maxPerItem) {
    return c.json({ error: `too many attachments (max ${maxPerItem})` }, 400);
  }

  // SYM-48: deliberately run to completion without binding `c.req.raw.signal` — closing the Ask
  // panel mid-run disconnects the client but must not abort the reply. Both turns are persisted
  // below regardless, so the next GET /ask/history (the panel's fresh-fetch reseed on reopen)
  // returns them. See the matching invariant in runProjectAsk.
  try {
    const result = await runProjectAsk(project, {
      question,
      history: normalizeHistory(body.history),
      agent: body.agent === 'codex' || body.agent === 'claude' ? body.agent : undefined,
      attachment_ids: attachmentIds,
    });
    // Persist the exchange under today's conversation so the panel can reload it (SYM-12). The
    // assistant turn carries its draft-issue suggestion so the card survives a conversation switch
    // (panel reopen / project switch) rather than being dropped on reseed (SYM-28). The user turn
    // carries its attachment links so re-displayed history shows the files (SYM-35).
    appendAskTurn(project.id, 'user', question, null, attachmentIds);
    appendAskTurn(project.id, 'assistant', result.answer, result.suggestion);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Today's persisted conversation, used to reseed the Ask panel when it opens (SYM-12). */
askRoutes.get('/:id/ask/history', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const history: AskHistory = {
    date: todaysAskDate(),
    messages: listTodaysAskMessages(project.id),
  };
  return c.json(history);
});

/** Manually reset today's conversation memory ("new conversation"). */
askRoutes.delete('/:id/ask/history', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  resetTodaysAsk(project.id);
  return c.json({ ok: true });
});

/** Keep only non-empty string ids from an untrusted attachment_ids payload (SYM-35). */
export function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/** Keep only well-formed {role, content} turns from an untrusted client payload. */
function normalizeHistory(value: unknown): AskMessage[] {
  if (!Array.isArray(value)) return [];
  const out: AskMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { role, content } = item as Record<string, unknown>;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      out.push({ role, content });
    }
  }
  return out;
}
