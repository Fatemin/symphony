import { TERMINAL_STATUSES } from '../../shared/types';
import { log } from '../observability/logger';
import { appendEvent } from '../repo/events';
import type { Tracker } from '../tracker/localTracker';
import type { RuntimeState } from './state';

/**
 * Active-run reconciliation, run at the top of every tick (Symphony §8.5). Two parts:
 *  A. Stall detection — abort a run that has produced no events for longer than the timeout.
 *  B. Status refresh — abort a run whose issue was cancelled/finished/removed out-of-band.
 *
 * Reconcile only *aborts* the run; the worker's completion handler removes it from state and
 * decides whether to retry (based on the issue's then-current status).
 */
export function reconcile(state: RuntimeState, tracker: Tracker, stallTimeoutMs: number): void {
  const now = Date.now();

  // Part A — stall detection.
  if (stallTimeoutMs > 0) {
    for (const entry of state.running.values()) {
      const elapsed = now - (entry.lastEventAt ?? entry.startedAt);
      if (elapsed > stallTimeoutMs && !entry.abort.signal.aborted) {
        log.warn('run stalled — aborting', { issue: entry.issueKey, elapsed_ms: elapsed });
        appendEvent({
          issue_id: entry.issueId,
          kind: 'reconcile.stall',
          level: 'warn',
          message: `aborted after ${Math.round(elapsed / 1000)}s with no agent activity`,
        });
        entry.abort.abort();
      }
    }
  }

  // Part B — tracker status refresh.
  const ids = [...state.running.keys()];
  if (ids.length === 0) return;
  const byId = new Map(tracker.fetchByIds(ids).map((i) => [i.id, i]));
  for (const entry of state.running.values()) {
    if (entry.abort.signal.aborted) continue;
    const issue = byId.get(entry.issueId);
    const reason = !issue
      ? 'removed'
      : TERMINAL_STATUSES.includes(issue.status)
        ? `status=${issue.status}`
        : issue.status !== 'in_progress'
          ? `status=${issue.status}`
          : null;
    if (reason) {
      log.info('run no longer eligible — aborting', { issue: entry.issueKey, reason });
      appendEvent({
        issue_id: entry.issueId,
        kind: 'reconcile.cancel',
        level: 'info',
        message: `run aborted (${reason})`,
      });
      entry.abort.abort();
    }
  }
}
