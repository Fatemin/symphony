import { buildImplementPrompt } from '../core/prompt';
import { getPlanContext } from '../repo/planContext';
import { listTasks, setAllTaskStatus } from '../repo/tasks';
import { commitWorktree } from '../workspace/worktree';
import { phasePrompt, resolveThinkingEffort, runPhaseAgent, type PhaseContext, type PhaseOutcome } from './types';

/**
 * Implement phase: ONE agent session implements the whole issue against its planned checklist
 * (no per-task subprocess fan-out — that was a complexity source in the old design). After the
 * agent finishes, the orchestrator commits the worktree so the change is captured regardless of
 * whether the agent committed itself.
 */
export async function runImplement(ctx: PhaseContext): Promise<PhaseOutcome> {
  const tasks = listTasks(ctx.issue.id);
  const planContext = getPlanContext(ctx.issue.id);
  setAllTaskStatus(ctx.issue.id, 'running');

  const prompt = buildImplementPrompt(
    {
      project: ctx.project,
      issue: ctx.issue,
      attempt: ctx.attempt,
      lastFailure: ctx.lastFailure,
      notes: ctx.notes,
      storyContext: ctx.storyContext,
      skills: ctx.skills,
      round: ctx.round,
      revisionFeedback: ctx.revisionFeedback,
      attachments: ctx.attachments,
      thinkingEffort: resolveThinkingEffort(ctx),
    },
    tasks,
    planContext,
    phasePrompt(ctx.projectConfig.prompts.implement, ctx.workflow?.prompts.implement),
  );
  const result = await runPhaseAgent(ctx, prompt);

  if (!result.ok) {
    setAllTaskStatus(ctx.issue.id, 'failed');
    return {
      ok: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'implementation failed',
      error: result.error ?? 'agent failed during implementation',
      errorKind: result.errorKind,
      retryAfterMs: result.retryAfterMs,
      report: result.text,
    };
  }

  const commit = await commitWorktree(ctx.worktreePath, `${ctx.issue.key}: ${ctx.issue.title}`, {
    guard: ctx.projectConfig.commit_guard,
  });
  if (!commit.ok) {
    setAllTaskStatus(ctx.issue.id, 'failed');
    return {
      ok: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'implementation commit failed',
      error: commit.reason ?? 'implementation commit failed',
    };
  }
  setAllTaskStatus(ctx.issue.id, 'done');

  return {
    ok: true,
    usage: result.usage,
    sessionId: result.sessionId,
    summary: commit.committed ? 'implemented and committed' : 'implemented (no file changes to commit)',
    report: result.text,
  };
}
