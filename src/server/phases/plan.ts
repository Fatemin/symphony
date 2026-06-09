import { buildPlanPrompt, parsePlan } from '../core/prompt';
import { replaceTasks } from '../repo/tasks';
import { agentInput, type PhaseContext, type PhaseOutcome } from './types';

/**
 * Plan phase: the agent reads the repo + issue and produces a task checklist (no code).
 * We persist the parsed tasks as the issue's checklist. An empty plan falls back to a single
 * "implement the issue" task so the implement phase always has something to drive against.
 */
export async function runPlan(ctx: PhaseContext): Promise<PhaseOutcome> {
  const prompt = buildPlanPrompt(
    { project: ctx.project, issue: ctx.issue, attempt: ctx.attempt },
    ctx.workflow?.prompts.plan,
  );
  const result = await ctx.runner(agentInput(ctx, prompt), ctx.onAgentEvent);

  if (!result.ok) {
    return {
      ok: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'planning failed',
      error: result.error ?? 'agent failed during planning',
    };
  }

  const parsed = parsePlan(result.text);
  const tasks = parsed.tasks.length
    ? parsed.tasks
    : [{ role: 'impl' as const, title: `Implement: ${ctx.issue.title}`, intent: null }];
  replaceTasks(ctx.issue.id, tasks);

  return {
    ok: true,
    usage: result.usage,
    sessionId: result.sessionId,
    summary: `planned ${tasks.length} task(s)${parsed.notes ? ` — ${parsed.notes}` : ''}`,
  };
}
