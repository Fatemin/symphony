import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { log } from '../observability/logger';
import type { AgentType, RunPhase } from '../../shared/types';
import type { PermissionMode } from './config';
import type { ProjectConfigInput } from './projectConfig';

/**
 * Optional per-repository policy (Symphony's "policy lives in the repo" principle). A target repo
 * may include a `WORKFLOW.md` whose YAML front matter overrides agent settings and appends
 * phase-specific prompt guidance. Read fresh per run (no file watching), so edits apply next run.
 */
export interface WorkflowPolicy {
  agent?: AgentType;
  model?: string;
  permission_mode?: PermissionMode;
  max_turns?: number;
  /** Per-phase caps (YAML: `max_turns: {implement: 150}`) — implement typically needs far more turns than qa. */
  max_turns_by_phase?: Partial<Record<RunPhase, number>>;
  prompts: { plan?: string; implement?: string; qa?: string; delivery?: string; merge?: string };
  config?: ProjectConfigInput;
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

/** Load + parse `<repoPath>/WORKFLOW.md`. Returns null when absent or malformed (logged). */
export function loadWorkflow(repoPath: string): WorkflowPolicy | null {
  const file = path.join(repoPath, 'WORKFLOW.md');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no WORKFLOW.md — use engine defaults
  }

  const frontMatter = extractFrontMatter(raw);
  if (!frontMatter) return null;

  let doc: unknown;
  try {
    doc = parseYaml(frontMatter);
  } catch (e) {
    log.warn('WORKFLOW.md front matter failed to parse — ignoring', { repoPath, err: String(e) });
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const obj = doc as Record<string, unknown>;
  const agent = (obj.agent ?? {}) as Record<string, unknown>;
  const prompts = (obj.prompts ?? {}) as Record<string, unknown>;
  const mode = typeof agent.permission_mode === 'string' ? agent.permission_mode : undefined;
  const agentType = agent.type === 'codex' || agent.type === 'claude' ? agent.type : undefined;

  return {
    agent: agentType,
    model: typeof agent.model === 'string' ? agent.model : undefined,
    permission_mode: mode && PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : undefined,
    ...parseMaxTurns(agent.max_turns),
    prompts: {
      plan: typeof prompts.plan === 'string' ? prompts.plan : undefined,
      implement: typeof prompts.implement === 'string' ? prompts.implement : undefined,
      qa: typeof prompts.qa === 'string' ? prompts.qa : undefined,
      delivery: typeof prompts.delivery === 'string' ? prompts.delivery : undefined,
      merge: typeof prompts.merge === 'string' ? prompts.merge : undefined,
    },
    config: workflowConfig(obj),
  };
}

/**
 * `max_turns` accepts a single number or a `{plan, implement, qa}` map of per-phase caps.
 * `0` disables the cap, matching the engine setting (claudeRunner omits --max-turns for 0).
 * Invalid values are dropped WITH a warning — a repo author whose cap is being ignored should
 * get a signal instead of silently running on the engine default.
 */
function parseMaxTurns(value: unknown): Pick<WorkflowPolicy, 'max_turns' | 'max_turns_by_phase'> {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const byPhase: Partial<Record<RunPhase, number>> = {};
    for (const phase of ['plan', 'implement', 'qa', 'delivery', 'merge'] as const) {
      const raw = (value as Record<string, unknown>)[phase];
      if (raw == null) continue;
      const n = coerceTurns(raw);
      if (n == null) log.warn('WORKFLOW.md max_turns value ignored', { phase, value: String(raw) });
      else byPhase[phase] = n;
    }
    return Object.keys(byPhase).length ? { max_turns_by_phase: byPhase } : {};
  }
  const n = coerceTurns(value);
  if (n == null) {
    log.warn('WORKFLOW.md max_turns value ignored', { value: String(value) });
    return {};
  }
  return { max_turns: n };
}

/** Numbers and numeric strings only (YAML quoting happens); booleans/arrays/blank are invalid. */
function coerceTurns(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function workflowConfig(obj: Record<string, unknown>): ProjectConfigInput | undefined {
  const config: ProjectConfigInput = {};
  if ('verification' in obj) config.verification = obj.verification as ProjectConfigInput['verification'];
  if ('promotion' in obj) config.promotion = obj.promotion as ProjectConfigInput['promotion'];
  if ('commit_guard' in obj) config.commit_guard = obj.commit_guard as ProjectConfigInput['commit_guard'];
  return Object.keys(config).length > 0 ? config : undefined;
}

/** Pull the YAML between a leading `---` fence and the next `---`. */
function extractFrontMatter(raw: string): string | null {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(3, end).trim();
}
