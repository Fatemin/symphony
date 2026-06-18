import type { RunPhase, RunningRow, RetryingRow, Snapshot } from '../../shared/types';
import { listRuns, sumTokens } from '../repo/runs';

export interface RunningEntry {
  issueId: string;
  issueKey: string;
  title: string;
  attempt: number;
  abort: AbortController;
  startedAt: number; // epoch ms
  lastEventAt: number | null;
}

export interface RetryEntry {
  issueId: string;
  issueKey: string;
  attempt: number; // attempt this retry will run as
  dueAt: number; // epoch ms
  timer: ReturnType<typeof setTimeout>;
  error: string | null;
}

/**
 * The single authoritative in-memory scheduling state (Symphony §4.1.8). Only the orchestrator
 * mutates it. `claimed` reserves an issue so it can't be double-dispatched while running OR while
 * a retry is queued. Token/runtime totals are derived from the DB plus live elapsed time.
 */
export class RuntimeState {
  readonly running = new Map<string, RunningEntry>();
  readonly retry = new Map<string, RetryEntry>();
  readonly claimed = new Set<string>();
  readonly completed = new Set<string>();
  suspendedUntil: number | null = null;
  suspendedReason: string | null = null;
  /** Cumulative wall-clock seconds of sessions that have already ended. */
  endedSeconds = 0;

  isClaimed(issueId: string): boolean {
    return this.claimed.has(issueId);
  }

  claim(issueId: string): void {
    this.claimed.add(issueId);
  }

  release(issueId: string): void {
    this.claimed.delete(issueId);
  }

  markEventActivity(issueId: string): void {
    const entry = this.running.get(issueId);
    if (entry) entry.lastEventAt = Date.now();
  }

  suspendUntil(until: number, reason: string): void {
    if (!this.suspendedUntil || until > this.suspendedUntil) {
      this.suspendedUntil = until;
      this.suspendedReason = reason;
    }
  }

  clearExpiredSuspension(now = Date.now()): void {
    if (this.suspendedUntil && this.suspendedUntil <= now) {
      this.suspendedUntil = null;
      this.suspendedReason = null;
    }
  }

  /** Build the observability snapshot (Symphony §13.3). Phase/tokens come from DB run rows. */
  snapshot(pollIntervalMs: number, wipLimit: number, enabled: boolean): Snapshot {
    const now = Date.now();
    const running: RunningRow[] = [];
    for (const e of this.running.values()) {
      const runs = listRuns(e.issueId);
      const latest = runs[0];
      running.push({
        issue_id: e.issueId,
        issue_key: e.issueKey,
        title: e.title,
        phase: (latest?.phase ?? 'plan') as RunPhase,
        attempt: e.attempt,
        started_at: e.startedAt,
        last_event_at: e.lastEventAt,
        num_turns: runs.reduce((s, r) => s + r.num_turns, 0),
        total_tokens: runs.reduce((s, r) => s + r.total_tokens, 0),
      });
    }

    const retrying: RetryingRow[] = [...this.retry.values()].map((r) => ({
      issue_id: r.issueId,
      issue_key: r.issueKey,
      attempt: r.attempt,
      due_at: r.dueAt,
      error: r.error,
    }));

    const activeSeconds = [...this.running.values()].reduce(
      (s, e) => s + (now - e.startedAt) / 1000,
      0,
    );
    const tokens = sumTokens();

    return {
      running,
      retrying,
      totals: {
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        total_tokens: tokens.total_tokens,
        seconds_running: Math.round(this.endedSeconds + activeSeconds),
      },
      poll_interval_ms: pollIntervalMs,
      wip_limit: wipLimit,
      enabled,
      // Only report a suspension that is still in effect; the timer is cleared lazily (in tick/
      // onRetryDue), so `suspendedUntil` may linger in the past until the next loop pass.
      suspended:
        this.suspendedUntil && this.suspendedUntil > now
          ? { until: this.suspendedUntil, reason: this.suspendedReason }
          : null,
    };
  }
}
