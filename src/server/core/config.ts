import { DEFAULT_WORKSPACE_ROOT } from '../env';

// Engine-wide runtime configuration. Defaults live here; the `settings` table holds
// UI-editable overrides; per-project rows can further override `model`. This module is
// intentionally free of DB imports so db/migrate.ts can seed DEFAULT_SETTINGS without a cycle.

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

export interface EngineConfig {
  /** Master switch — when false the orchestrator dispatches nothing. */
  enabled: boolean;
  /** Path to the Claude Code CLI binary (resolved on PATH by default). */
  cli_path: string;
  /** Default model passed to the CLI (`--model`). */
  model: string;
  /** CLI permission mode for headless runs. */
  permission_mode: PermissionMode;
  /** Max concurrent issue runs. */
  wip_limit: number;
  /** Orchestrator poll cadence. */
  poll_interval_ms: number;
  /** Root under which per-issue worktrees are created. */
  workspace_root: string;
  /** Wall-clock cap for a single phase's agent session. */
  phase_timeout_ms: number;
  /** Kill a run after this long with no agent events. <=0 disables stall detection. */
  stall_timeout_ms: number;
  /** CLI `--max-turns` cap per phase; bounds a single session's cost. */
  max_turns: number;
  /** Give up + park the issue to manual after this many failed attempts. */
  max_attempts: number;
  /** Cap on exponential retry backoff. */
  max_retry_backoff_ms: number;
}

export const DEFAULT_SETTINGS: EngineConfig = {
  enabled: true,
  cli_path: process.platform === 'win32' ? 'claude.cmd' : 'claude',
  model: 'claude-sonnet-4-6',
  permission_mode: 'bypassPermissions',
  wip_limit: 3,
  poll_interval_ms: 30_000,
  workspace_root: DEFAULT_WORKSPACE_ROOT,
  phase_timeout_ms: 20 * 60_000,
  stall_timeout_ms: 5 * 60_000,
  max_turns: 60,
  max_attempts: 3,
  max_retry_backoff_ms: 5 * 60_000,
};

const NUMERIC_KEYS: (keyof EngineConfig)[] = [
  'wip_limit',
  'poll_interval_ms',
  'phase_timeout_ms',
  'stall_timeout_ms',
  'max_turns',
  'max_attempts',
  'max_retry_backoff_ms',
];

/**
 * Merges raw settings rows (already JSON-parsed) onto defaults with light coercion.
 * Unknown keys are ignored; invalid values fall back to the default for that key.
 */
export function resolveConfig(raw: Record<string, unknown>): EngineConfig {
  const cfg: EngineConfig = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof EngineConfig)[]) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (NUMERIC_KEYS.includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) (cfg[key] as number) = n;
    } else if (key === 'enabled') {
      cfg.enabled = Boolean(value);
    } else if (typeof value === 'string' && value.length > 0) {
      (cfg[key] as string) = value;
    }
  }
  return cfg;
}
