import type { AgentRunner } from '../agent/types';
import type { EngineConfig } from '../core/config';
import type { EventWithCursor } from '../repo/events';
import { runIssuePipeline, type PipelineResult } from '../phases/index';
import type { RuntimeState } from './state';

export interface ExecuteDeps {
  runner: AgentRunner;
  config: EngineConfig;
  /** SSE sink — forwarded persisted events. */
  onEvent?: (event: EventWithCursor) => void;
}

/**
 * Run one issue's pipeline. The only logic here beyond delegating to the execution layer is
 * wiring each persisted event back into stall-detection (every event for this issue resets its
 * activity clock) and forwarding events to the SSE sink.
 */
export function executeIssue(
  state: RuntimeState,
  issueId: string,
  attempt: number,
  signal: AbortSignal,
  deps: ExecuteDeps,
): Promise<PipelineResult> {
  const onEvent = (event: EventWithCursor) => {
    if (event.issue_id === issueId) state.markEventActivity(issueId);
    deps.onEvent?.(event);
  };
  return runIssuePipeline(issueId, {
    runner: deps.runner,
    config: deps.config,
    attempt,
    signal,
    onEvent,
  });
}
