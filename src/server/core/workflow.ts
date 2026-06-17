import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { log } from '../observability/logger';
import type { PermissionMode } from './config';
import type { ProjectConfigInput } from './projectConfig';

/**
 * Optional per-repository policy (Symphony's "policy lives in the repo" principle). A target repo
 * may include a `WORKFLOW.md` whose YAML front matter overrides agent settings and appends
 * phase-specific prompt guidance. Read fresh per run (no file watching), so edits apply next run.
 */
export interface WorkflowPolicy {
  model?: string;
  permission_mode?: PermissionMode;
  max_turns?: number;
  prompts: { plan?: string; implement?: string; qa?: string };
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

  return {
    model: typeof agent.model === 'string' ? agent.model : undefined,
    permission_mode: mode && PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : undefined,
    max_turns: Number.isFinite(Number(agent.max_turns)) && agent.max_turns != null ? Number(agent.max_turns) : undefined,
    prompts: {
      plan: typeof prompts.plan === 'string' ? prompts.plan : undefined,
      implement: typeof prompts.implement === 'string' ? prompts.implement : undefined,
      qa: typeof prompts.qa === 'string' ? prompts.qa : undefined,
    },
    config: workflowConfig(obj),
  };
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
