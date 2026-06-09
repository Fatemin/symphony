import type { PermissionMode } from '../core/config';

// The agent-runner contract. The orchestrator/phases depend only on these types, never on
// the Claude CLI directly — so tests inject a fake runner with the same signature (no module
// seams). This is the single boundary between deterministic logic and the non-deterministic,
// token-spending agent process.

export interface AgentRunInput {
  /** Working directory — MUST be the issue's worktree (Safety Invariant §9.5). */
  cwd: string;
  /** Fully rendered prompt fed to the agent on stdin. */
  prompt: string;
  /** Optional extra system prompt appended to the CLI's. */
  systemPrompt?: string;
  model: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  timeoutMs: number;
  cliPath: string;
  /** Abort the run (orchestrator reconciliation / shutdown). */
  signal?: AbortSignal;
}

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  num_turns: number;
}

/** Streamed, normalized agent events (observability + token accounting). */
export type AgentEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; text: string }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'error'; message: string };

export interface AgentResult {
  ok: boolean;
  sessionId: string | null;
  /** Final assistant result text (the CLI `result` field). */
  text: string;
  usage: AgentUsage;
  durationMs: number;
  error?: string;
}

/**
 * Runs one agent session to completion, streaming events through `onEvent` and resolving
 * with the final aggregated result. Never throws for agent-level failures — it resolves
 * with `ok:false` so the orchestrator can decide retry behavior.
 */
export type AgentRunner = (
  input: AgentRunInput,
  onEvent?: (event: AgentEvent) => void,
) => Promise<AgentResult>;
