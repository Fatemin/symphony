import { buildDeliveryPrompt } from '../core/prompt';
import { phasePrompt, runPhaseAgent, type PhaseContext, type PhaseOutcome } from './types';

/**
 * Delivery phase (§SYM-22): after QA passes, a fresh agent summarizes the round in user-friendly
 * language — what shipped, how to use it, and which files/docs changed. The agent's report IS the
 * deliverable (no PASS/FAIL verdict). It is strictly read-only — no commitWorktree, mirroring the
 * merge agent — so it never dirties the tree ahead of objective verification. The sequencer treats
 * a failure here as non-blocking: a missing summary must never gate landing or the review gate.
 */
export async function runDelivery(ctx: PhaseContext): Promise<PhaseOutcome> {
  const prompt = buildDeliveryPrompt(
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
    ctx.implementReport ?? null,
    phasePrompt(ctx.projectConfig.prompts.delivery, ctx.workflow?.prompts.delivery),
  );
  const result = await runPhaseAgent(ctx, prompt);

  if (!result.ok) {
    return {
      ok: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'delivery summary failed',
      error: result.error ?? 'agent failed during delivery',
      errorKind: result.errorKind,
      retryAfterMs: result.retryAfterMs,
      report: result.text,
    };
  }

  return {
    ok: true,
    usage: result.usage,
    sessionId: result.sessionId,
    summary: 'delivery summary ready',
    report: result.text,
  };
}
