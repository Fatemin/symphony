import type { EngineConfig } from '../core/config';
import type { Issue, Snapshot } from '../../shared/types';
import { log } from '../observability/logger';
import { appendEvent, type EventWithCursor } from '../repo/events';
import { getIssue, isActive, isTerminal, setStatus, updateIssue } from '../repo/issues';
import { finishRun, listDanglingRuns } from '../repo/runs';
import { getConfig as readConfig } from '../repo/settings';
import { runClaudeCode } from '../agent/claudeRunner';
import type { AgentRunner } from '../agent/types';
import { localTracker, type Tracker } from '../tracker/localTracker';
import type { PipelineResult } from '../phases/index';
import { RuntimeState, type RunningEntry } from './state';
import { reconcile } from './reconcile';
import { backoffMs, cancelRetry, scheduleRetry } from './retry';
import { executeIssue } from './worker';

export interface OrchestratorDeps {
  tracker?: Tracker;
  runner?: AgentRunner;
  getConfig?: () => EngineConfig;
  /** SSE sink for live run events. */
  onEvent?: (event: EventWithCursor) => void;
}

/**
 * The single authority over scheduling (Symphony §7). Owns the poll loop, the runtime state,
 * and every state transition (dispatch / retry / release / give-up). Workers report outcomes
 * back here; nothing else mutates `RuntimeState`.
 */
export class Orchestrator {
  private readonly state = new RuntimeState();
  private readonly tracker: Tracker;
  private readonly runner: AgentRunner;
  private readonly getConfig: () => EngineConfig;
  private readonly onEvent?: (event: EventWithCursor) => void;

  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = true;

  constructor(deps: OrchestratorDeps = {}) {
    this.tracker = deps.tracker ?? localTracker;
    this.runner = deps.runner ?? runClaudeCode;
    this.getConfig = deps.getConfig ?? readConfig;
    this.onEvent = deps.onEvent;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    log.info('orchestrator started', { wip_limit: this.getConfig().wip_limit });
    this.scheduleNext(0); // immediate first tick
  }

  stop(): void {
    this.stopped = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    for (const entry of this.state.running.values()) entry.abort.abort();
    for (const id of [...this.state.retry.keys()]) cancelRetry(this.state, id);
    log.info('orchestrator stopped');
  }

  /** Force an immediate tick (used by the API "kick" and by tests). */
  async kick(): Promise<void> {
    await this.tick();
  }

  /**
   * Dispatch one specific issue immediately, bypassing the auto-mode filter. Backs the manual
   * "Run" button. Respects claim/running dedup and the WIP limit.
   */
  runNow(issueId: string): { ok: boolean; reason?: string } {
    const issue = getIssue(issueId);
    if (!issue) return { ok: false, reason: 'issue not found' };
    if (isTerminal(issue.status)) return { ok: false, reason: `issue is ${issue.status}` };
    if (this.state.running.has(issueId) || this.state.isClaimed(issueId)) {
      return { ok: false, reason: 'already running or queued' };
    }
    if (this.availableSlots(this.getConfig()) <= 0) {
      return { ok: false, reason: 'no free slots — raise the WIP limit or wait' };
    }
    // Move into an active status so reconciliation won't immediately abort it.
    if (!isActive(issue.status)) setStatus(issueId, 'todo');
    this.dispatch(getIssue(issueId)!, 1);
    return { ok: true };
  }

  snapshot(): Snapshot {
    const cfg = this.getConfig();
    return this.state.snapshot(cfg.poll_interval_ms, cfg.wip_limit, cfg.enabled);
  }

  // ── poll loop ─────────────────────────────────────────────────────────────

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.loopTimer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext(this.getConfig().poll_interval_ms));
    }, delayMs);
    if (typeof this.loopTimer.unref === 'function') this.loopTimer.unref();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      const cfg = this.getConfig();
      reconcile(this.state, this.tracker, cfg.stall_timeout_ms);
      if (!cfg.enabled) return;

      for (const issue of this.tracker.fetchCandidates()) {
        if (this.availableSlots(cfg) <= 0) break;
        if (this.state.isClaimed(issue.id) || this.state.running.has(issue.id)) continue;
        this.dispatch(issue, 1);
      }
    } catch (e) {
      log.error('tick failed', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      this.ticking = false;
    }
  }

  private availableSlots(cfg: EngineConfig): number {
    return Math.max(cfg.wip_limit - this.state.running.size, 0);
  }

  // ── dispatch + outcome ─────────────────────────────────────────────────────

  private dispatch(issue: Issue, attempt: number): void {
    this.state.claim(issue.id);
    const abort = new AbortController();
    const entry: RunningEntry = {
      issueId: issue.id,
      issueKey: issue.key,
      title: issue.title,
      attempt,
      abort,
      startedAt: Date.now(),
      lastEventAt: null,
    };
    this.state.running.set(issue.id, entry);
    appendEvent({
      issue_id: issue.id,
      kind: 'orchestrator.dispatch',
      message: `dispatched (attempt ${attempt})`,
      data: { attempt },
    });

    executeIssue(this.state, issue.id, attempt, abort.signal, {
      runner: this.runner,
      config: this.getConfig(),
      onEvent: this.onEvent,
    })
      .then((result) => this.handleOutcome(issue, attempt, result))
      .catch((err) =>
        this.handleOutcome(issue, attempt, {
          ok: false,
          finalStatus: 'in_progress',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  private handleOutcome(issue: Issue, attempt: number, result: PipelineResult): void {
    const entry = this.state.running.get(issue.id);
    if (entry) {
      this.state.endedSeconds += (Date.now() - entry.startedAt) / 1000;
      this.state.running.delete(issue.id);
    }

    const current = getIssue(issue.id);

    // Success, or the issue became terminal (e.g. a human cancelled mid-run): release the claim.
    if (result.ok || !current || isTerminal(current.status)) {
      this.state.completed.add(issue.id);
      this.state.release(issue.id);
      return;
    }

    if (result.park) {
      updateIssue(issue.id, { mode: 'manual' });
      appendEvent({
        issue_id: issue.id,
        kind: 'orchestrator.park',
        level: 'warn',
        message: 'parked to manual by project policy',
        data: { attempt, error: result.error },
      });
      this.state.release(issue.id);
      return;
    }

    // Failure while still active → retry with backoff, or give up after max attempts.
    const cfg = this.getConfig();
    if (attempt >= cfg.max_attempts) {
      updateIssue(issue.id, { mode: 'manual' });
      appendEvent({
        issue_id: issue.id,
        kind: 'orchestrator.giveup',
        level: 'error',
        message: `gave up after ${attempt} attempts — parked to manual`,
        data: { attempt, error: result.error },
      });
      this.state.release(issue.id);
      return;
    }

    const delayMs = backoffMs(attempt, cfg.max_retry_backoff_ms);
    appendEvent({
      issue_id: issue.id,
      kind: 'orchestrator.retry',
      level: 'warn',
      message: `attempt ${attempt} failed — retrying in ${Math.round(delayMs / 1000)}s`,
      data: { attempt, delayMs, error: result.error },
    });
    scheduleRetry(
      this.state,
      { issueId: issue.id, issueKey: issue.key, nextAttempt: attempt + 1, delayMs, error: result.error ?? null },
      () => this.onRetryDue(issue.id, attempt + 1),
    );
  }

  private onRetryDue(issueId: string, attempt: number): void {
    const issue = this.tracker.fetchByIds([issueId])[0];
    if (!issue || !isActive(issue.status)) {
      appendEvent({
        issue_id: issue?.id,
        kind: 'orchestrator.drop',
        level: 'warn',
        message: issue
          ? `queued retry dropped — issue is ${issue.status}`
          : 'queued retry dropped — issue was deleted',
        data: { attempt },
      });
      this.state.release(issueId);
      return;
    }
    if (this.availableSlots(this.getConfig()) <= 0) {
      // No slots — requeue shortly (Symphony §8.4 "no available orchestrator slots").
      scheduleRetry(
        this.state,
        { issueId, issueKey: issue.key, nextAttempt: attempt, delayMs: 5000, error: 'no available orchestrator slots' },
        () => this.onRetryDue(issueId, attempt),
      );
      return;
    }
    this.dispatch(issue, attempt);
  }

  // ── restart recovery (Symphony §7.4) ───────────────────────────────────────

  private recover(): void {
    // Run rows left "running" belong to a dead process — close them out.
    const dangling = listDanglingRuns();
    for (const run of dangling) finishRun(run.id, 'cancelled', 'recovered: process restart');
    if (dangling.length > 0) {
      log.info('recovered dangling runs', { count: dangling.length });
    }
    // Issues stuck `in_progress` + `auto` are still active candidates and will be re-dispatched
    // by the normal poll loop — no special handling needed.
  }
}

// Process-wide singleton for the HTTP server to share.
let _orchestrator: Orchestrator | null = null;

export function getOrchestrator(deps?: OrchestratorDeps): Orchestrator {
  if (!_orchestrator) _orchestrator = new Orchestrator(deps);
  return _orchestrator;
}
