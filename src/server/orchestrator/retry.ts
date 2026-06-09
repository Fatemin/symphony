import type { RuntimeState } from './state';

/**
 * Failure-driven backoff (Symphony §8.4): delay = min(10000 · 2^(attempt-1), maxBackoff).
 * `attempt` is the attempt number that just failed (1-based).
 */
export function backoffMs(attempt: number, maxBackoffMs: number): number {
  const base = 10_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, maxBackoffMs);
}

/**
 * Schedule a retry for an issue. Cancels any existing timer for it first, then fires `onDue`
 * after the backoff. The issue stays `claimed` while queued so it isn't double-dispatched.
 */
export function scheduleRetry(
  state: RuntimeState,
  args: { issueId: string; issueKey: string; nextAttempt: number; delayMs: number; error: string | null },
  onDue: () => void,
): void {
  const existing = state.retry.get(args.issueId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    state.retry.delete(args.issueId);
    onDue();
  }, args.delayMs);
  // Don't keep the event loop alive solely for a pending retry.
  if (typeof timer.unref === 'function') timer.unref();

  state.retry.set(args.issueId, {
    issueId: args.issueId,
    issueKey: args.issueKey,
    attempt: args.nextAttempt,
    dueAt: Date.now() + args.delayMs,
    timer,
    error: args.error,
  });
}

export function cancelRetry(state: RuntimeState, issueId: string): void {
  const existing = state.retry.get(issueId);
  if (existing) {
    clearTimeout(existing.timer);
    state.retry.delete(issueId);
  }
}
