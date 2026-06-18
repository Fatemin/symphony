import { buildQaPrompt, parseQa } from '../core/prompt';
import { commitAll } from '../workspace/worktree';
import { runPhaseAgent, type PhaseContext, type QaOutcome } from './types';

/**
 * QA phase: a fresh agent verifies the committed work against the acceptance criteria and emits
 * a PASS/FAIL verdict. Any trivial fixes it makes are committed. A FAIL (or a failed agent run)
 * makes the phase unsuccessful so the orchestrator retries.
 */
export async function runQa(ctx: PhaseContext): Promise<QaOutcome> {
  const prompt = buildQaPrompt(
    { project: ctx.project, issue: ctx.issue, attempt: ctx.attempt, lastFailure: ctx.lastFailure, notes: ctx.notes },
    ctx.implementReport ?? null,
    ctx.workflow?.prompts.qa,
  );
  const result = await runPhaseAgent(ctx, prompt);

  if (!result.ok) {
    return {
      ok: false,
      pass: false,
      usage: result.usage,
      sessionId: result.sessionId,
      summary: 'QA run failed',
      error: result.error ?? 'agent failed during QA',
      errorKind: result.errorKind,
      retryAfterMs: result.retryAfterMs,
      report: result.text,
    };
  }

  const verdict = parseQa(result.text);
  await commitAll(ctx.worktreePath, `${ctx.issue.key}: QA fixes`);

  return {
    ok: verdict.pass,
    pass: verdict.pass,
    usage: result.usage,
    sessionId: result.sessionId,
    summary: `QA ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.reason}`,
    error: verdict.pass ? undefined : `QA failed: ${verdict.reason}`,
    report: result.text,
  };
}
