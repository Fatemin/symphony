import { buildPlanPrompt, parsePlan } from '../core/prompt';
import { savePlanContext } from '../repo/planContext';
import { replaceTasks } from '../repo/tasks';
import { phasePrompt, runPhaseAgent, type PhaseContext, type PhaseOutcome } from './types';

/**
 * Plan phase: the agent reads the repo + issue and produces a task checklist (no code).
 * We persist the parsed tasks as the issue's checklist. An empty plan falls back to a single
 * "implement the issue" task so the implement phase always has something to drive against.
 */
export async function runPlan(ctx: PhaseContext): Promise<PhaseOutcome> {
  const prompt = buildPlanPrompt(
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
    },
    phasePrompt(ctx.projectConfig.prompts.plan, ctx.workflow?.prompts.plan),
  );
  const result = await runPhaseAgent(ctx, prompt);

  if (!result.ok) {
    return {
      ok: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'planning failed',
      error: result.error ?? 'agent failed during planning',
      errorKind: result.errorKind,
      retryAfterMs: result.retryAfterMs,
      report: result.text,
    };
  }

  const parsed = parsePlan(result.text);
  const tasks = parsed.tasks.length
    ? parsed.tasks
    : [{ role: 'impl' as const, title: `Implement: ${ctx.issue.title}`, intent: null }];
  replaceTasks(ctx.issue.id, tasks);
  savePlanContext(ctx.issue.id, {
    notes: parsed.notes,
    context: parsed.context,
    key_files: parsed.key_files,
  });

  return {
    ok: true,
    usage: result.usage,
    sessionId: result.sessionId,
    summary: `planned ${tasks.length} task(s), mapped ${parsed.key_files.length} file(s)${parsed.notes ? ` — ${parsed.notes}` : ''}`,
    report: result.text,
  };
}
