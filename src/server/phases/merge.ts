import { buildMergePrompt, parseMerge } from '../core/prompt';
import { phasePrompt, runPhaseAgent, type PhaseContext, type PhaseOutcome } from './types';

/**
 * Merge phase (§SYM-16): a fresh agent pushes the issue's branch to the remote and integrates it
 * into the base branch there. This fills the gap in the autonomous `done` path, which previously
 * marked an issue done WITHOUT ever pushing — the work never reached GitHub. Unlike QA there is no
 * commitWorktree: the merge agent owns whatever git/gh commands it runs. A FAIL (or a failed agent
 * run) makes the phase unsuccessful so the orchestrator retries the push.
 */
export async function runMerge(ctx: PhaseContext): Promise<PhaseOutcome> {
  const prompt = buildMergePrompt(
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
    {
      remote: ctx.projectConfig.promotion.remote,
      branch: ctx.issue.branch_name ?? '(agent branch)',
      baseBranch: ctx.issue.base_branch ?? ctx.project.default_branch,
    },
    phasePrompt(ctx.projectConfig.prompts.merge, ctx.workflow?.prompts.merge),
  );
  const result = await runPhaseAgent(ctx, prompt);

  if (!result.ok) {
    return {
      ok: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'merge run failed',
      error: result.error ?? 'agent failed during merge',
      errorKind: result.errorKind,
      retryAfterMs: result.retryAfterMs,
      report: result.text,
    };
  }

  const verdict = parseMerge(result.text);
  return {
    ok: verdict.pass,
    usage: result.usage,
    sessionId: result.sessionId,
    summary: `merge ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.reason}`,
    error: verdict.pass ? undefined : `merge failed: ${verdict.reason}`,
    report: result.text,
  };
}
