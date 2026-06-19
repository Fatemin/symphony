import type { RunPhase } from '../../shared/types';
import type { PermissionMode } from './config';

export type VerificationFailureAction = 'retry' | 'park';

export interface VerificationCommandConfig {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  on_failure?: VerificationFailureAction;
}

export interface VerificationConfig {
  commands: VerificationCommandConfig[];
}

export type PromotionMode = 'direct-merge' | 'pull-request';

export interface PromotionConfig {
  mode: PromotionMode;
  base_branch?: string;
  remote: string;
  auto_merge: boolean;
  check_poll_interval_ms: number;
  check_timeout_ms: number;
}

export interface CommitGuardConfig {
  enabled: boolean;
  blocked_untracked_globs: string[];
  max_files?: number;
  max_bytes?: number;
  override_limits: boolean;
}

export interface ProjectAgentConfig {
  permission_mode?: PermissionMode;
  max_turns?: number;
  max_turns_by_phase?: Partial<Record<RunPhase, number>>;
}

export interface ProjectPromptConfig {
  plan?: string;
  implement?: string;
  qa?: string;
}

export interface ProjectConfig {
  agent: ProjectAgentConfig;
  prompts: ProjectPromptConfig;
  verification: VerificationConfig;
  promotion: PromotionConfig;
  commit_guard: CommitGuardConfig;
}

export type ProjectConfigInput = Partial<{
  agent: Partial<ProjectAgentConfig>;
  prompts: Partial<ProjectPromptConfig>;
  verification: Partial<VerificationConfig>;
  promotion: Partial<PromotionConfig>;
  commit_guard: Partial<CommitGuardConfig>;
}>;

export const DEFAULT_BLOCKED_UNTRACKED_GLOBS = [
  '*_TEMP.*',
  '*_TEMP',
  'scratch*.md',
  'SCRATCH*.md',
  'scratch/**',
];

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  agent: {},
  prompts: {},
  verification: { commands: [] },
  promotion: {
    mode: 'direct-merge',
    remote: 'origin',
    auto_merge: false,
    check_poll_interval_ms: 15_000,
    check_timeout_ms: 10 * 60_000,
  },
  commit_guard: {
    enabled: false,
    blocked_untracked_globs: DEFAULT_BLOCKED_UNTRACKED_GLOBS,
    override_limits: false,
  },
};

export function parseProjectConfig(value: unknown): ProjectConfig {
  const input = coerceConfigInput(value);
  return mergeProjectConfigs(DEFAULT_PROJECT_CONFIG, input);
}

export function mergeProjectConfigs(...configs: unknown[]): ProjectConfig {
  const out: ProjectConfig = cloneProjectConfig(DEFAULT_PROJECT_CONFIG);
  for (const config of configs) {
    const input = coerceConfigInput(config);
    if (!input) continue;
    mergeAgent(out, input.agent);
    mergePrompts(out, input.prompts);
    mergeVerification(out, input.verification);
    mergePromotion(out, input.promotion);
    mergeCommitGuard(out, input.commit_guard);
  }
  return out;
}

export function serializeProjectConfig(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(parseProjectConfig(value));
}

function mergeAgent(out: ProjectConfig, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  if (isPermissionMode(obj.permission_mode)) out.agent.permission_mode = obj.permission_mode;
  const flatTurns = numberOrUndefined(obj.max_turns);
  if (flatTurns !== undefined) out.agent.max_turns = flatTurns;

  // Merge per-phase so a later layer (e.g. WORKFLOW.md) that sets one phase doesn't wipe the
  // phases an earlier layer set — matching mergePromotion/mergeCommitGuard's field-wise merge.
  const phaseTurns = parsePhaseTurns(obj.max_turns_by_phase ?? obj.max_turns);
  if (phaseTurns) out.agent.max_turns_by_phase = { ...out.agent.max_turns_by_phase, ...phaseTurns };
}

function mergePrompts(out: ProjectConfig, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  for (const phase of ['plan', 'implement', 'qa'] as const) {
    const value = obj[phase];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) out.prompts[phase] = trimmed;
      else delete out.prompts[phase];
    }
  }
}

function mergeVerification(out: ProjectConfig, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const commands = (raw as Record<string, unknown>).commands;
  if (!Array.isArray(commands)) return;
  out.verification.commands = commands
    .map(parseVerificationCommand)
    .filter((c): c is VerificationCommandConfig => c !== null);
}

function parseVerificationCommand(raw: unknown): VerificationCommandConfig | null {
  if (typeof raw === 'string') {
    const command = raw.trim();
    return command ? { command } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) return null;
  const cwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : undefined;
  const timeout = numberOrUndefined(obj.timeout_ms);
  const action = obj.on_failure === 'park' ? 'park' : obj.on_failure === 'retry' ? 'retry' : undefined;
  return {
    command,
    ...(cwd ? { cwd } : {}),
    ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
    ...(action ? { on_failure: action } : {}),
  };
}

function mergePromotion(out: ProjectConfig, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  if (obj.mode === 'pull-request' || obj.mode === 'direct-merge') out.promotion.mode = obj.mode;
  if (typeof obj.base_branch === 'string' && obj.base_branch.trim()) out.promotion.base_branch = obj.base_branch.trim();
  if (typeof obj.remote === 'string' && obj.remote.trim()) out.promotion.remote = obj.remote.trim();
  if (typeof obj.auto_merge === 'boolean') out.promotion.auto_merge = obj.auto_merge;
  const poll = numberOrUndefined(obj.check_poll_interval_ms);
  if (poll !== undefined) out.promotion.check_poll_interval_ms = poll;
  const timeout = numberOrUndefined(obj.check_timeout_ms);
  if (timeout !== undefined) out.promotion.check_timeout_ms = timeout;
}

function mergeCommitGuard(out: ProjectConfig, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === 'boolean') out.commit_guard.enabled = obj.enabled;
  const globs = obj.blocked_untracked_globs;
  if (Array.isArray(globs)) {
    const parsed = globs.map((g) => (typeof g === 'string' ? g.trim() : '')).filter(Boolean);
    out.commit_guard.blocked_untracked_globs = parsed;
  }
  const maxFiles = numberOrUndefined(obj.max_files);
  if (maxFiles !== undefined) out.commit_guard.max_files = maxFiles;
  const maxBytes = numberOrUndefined(obj.max_bytes);
  if (maxBytes !== undefined) out.commit_guard.max_bytes = maxBytes;
  if (typeof obj.override_limits === 'boolean') out.commit_guard.override_limits = obj.override_limits;
}

function coerceConfigInput(value: unknown): ProjectConfigInput | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      return coerceConfigInput(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ProjectConfigInput;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parsePhaseTurns(value: unknown): Partial<Record<RunPhase, number>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Partial<Record<RunPhase, number>> = {};
  for (const phase of ['plan', 'implement', 'qa'] as const) {
    const turns = numberOrUndefined((value as Record<string, unknown>)[phase]);
    if (turns !== undefined) out[phase] = turns;
  }
  return Object.keys(out).length ? out : undefined;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions' || value === 'plan';
}

function cloneProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    agent: {
      ...config.agent,
      max_turns_by_phase: config.agent.max_turns_by_phase ? { ...config.agent.max_turns_by_phase } : undefined,
    },
    prompts: { ...config.prompts },
    verification: { commands: config.verification.commands.map((c) => ({ ...c })) },
    promotion: { ...config.promotion },
    commit_guard: {
      ...config.commit_guard,
      blocked_untracked_globs: [...config.commit_guard.blocked_untracked_globs],
    },
  };
}
