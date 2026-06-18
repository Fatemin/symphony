import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Bot, Plus, Save, Trash2 } from 'lucide-react';
import type { AgentType, Project } from '../../shared/types';
import { AGENT_OPTIONS, AVAILABLE_MODELS } from '../../shared/models';
import {
  api,
  type ProjectRunPhase,
  type ProjectWorkflowConfig,
  type VerificationCommandConfig,
} from '../api';
import { ProjectTabs } from '../components/ProjectTabs';
import { Button, Field, Input, Panel, Select, Textarea } from '../components/ui';

const PHASES: ProjectRunPhase[] = ['plan', 'implement', 'qa'];

interface AgentForm {
  context: string;
  agent: AgentType | ''; // '' ⇒ inherit the global default agent
  model: string;
  config: ProjectWorkflowConfig;
}

const DEFAULT_CONFIG: ProjectWorkflowConfig = {
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
    blocked_untracked_globs: ['*_TEMP.*', '*_TEMP', 'scratch*.md', 'SCRATCH*.md', 'scratch/**'],
    override_limits: false,
  },
};

export function ProjectAgent() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id!),
  });
  const [form, setForm] = useState<AgentForm | null>(null);

  useEffect(() => {
    if (!project) return;
    setForm({
      context: project.context ?? '',
      agent: project.agent ?? '',
      model: project.model ?? '',
      config: normalizeConfig(project.config),
    });
  }, [project]);

  const save = useMutation({
    mutationFn: () => {
      if (!project || !form) throw new Error('project not loaded');
      return api.projects.update(project.id, {
        context: blankToNull(form.context),
        agent: form.agent || null, // null ⇒ clear the override and inherit the global default
        model: blankToNull(form.model),
        config: sanitizeConfig(form.config),
      } satisfies Partial<Project>);
    },
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project', updated.id] });
      setForm({
        context: updated.context ?? '',
        agent: updated.agent ?? '',
        model: updated.model ?? '',
        config: normalizeConfig(updated.config),
      });
      toast.success('Agent settings saved');
    },
    onError: (e) => toast.error(String(e)),
  });

  if (!project || !form) return <div className="p-8 text-sm text-slate-500">Loading…</div>;

  const setConfig = (updater: (config: ProjectWorkflowConfig) => ProjectWorkflowConfig) => {
    setForm((current) => (current ? { ...current, config: updater(current.config) } : current));
  };
  const config = form.config;

  return (
    <div className="flex h-full flex-col p-6">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-slate-500 hover:text-slate-300">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="grid h-7 w-7 place-items-center rounded text-xs font-bold" style={{ background: project.color + '33', color: project.color }}>
            {project.key}
          </span>
          <h1 className="text-lg font-semibold">{project.name}</h1>
        </div>
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          <Save className="h-4 w-4" /> Save
        </Button>
      </header>

      <ProjectTabs projectId={project.id} />

      <div className="grid max-w-6xl grid-cols-1 gap-4 pb-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Panel className="p-4">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
              <Bot className="h-4 w-4 text-indigo-300" />
              Agent
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Agent">
                <Select
                  value={form.agent}
                  onChange={(e) => setForm({ ...form, agent: e.target.value as AgentType | '' })}
                >
                  <option value="">global default</option>
                  {AGENT_OPTIONS.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Model override">
                <Input
                  list="agent-models"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="global default"
                />
                <datalist id="agent-models">
                  {AVAILABLE_MODELS.filter((m) => !form.agent || m.agent === form.agent).map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Permission mode">
                <Select
                  value={config.agent.permission_mode ?? ''}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      agent: { ...c.agent, permission_mode: e.target.value || undefined },
                    }))
                  }
                >
                  <option value="">global default</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="default">default</option>
                  <option value="plan">plan</option>
                </Select>
              </Field>
              <Field label="Max turns">
                <Input
                  type="number"
                  min={0}
                  value={config.agent.max_turns ?? ''}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      agent: { ...c.agent, max_turns: optionalNumber(e.target.value) },
                    }))
                  }
                  placeholder="global default"
                />
              </Field>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:col-span-2">
                {PHASES.map((phase) => (
                  <Field key={phase} label={`${phase} turns`}>
                    <Input
                      type="number"
                      min={0}
                      value={config.agent.max_turns_by_phase?.[phase] ?? ''}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          agent: {
                            ...c.agent,
                            max_turns_by_phase: setPhaseTurns(c.agent.max_turns_by_phase, phase, optionalNumber(e.target.value)),
                          },
                        }))
                      }
                      placeholder="default"
                    />
                  </Field>
                ))}
              </div>
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="mb-4 text-sm font-medium text-slate-200">Prompting</div>
            <div className="space-y-4">
              <Field label="Project context">
                <Textarea
                  rows={5}
                  value={form.context}
                  onChange={(e) => setForm({ ...form, context: e.target.value })}
                  placeholder="Conventions, data model notes, gotchas..."
                />
              </Field>
              <div className="grid gap-4 lg:grid-cols-3">
                {PHASES.map((phase) => (
                  <Field key={phase} label={`${phase} prompt`}>
                    <Textarea
                      rows={8}
                      value={config.prompts[phase] ?? ''}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          prompts: { ...c.prompts, [phase]: e.target.value },
                        }))
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm font-medium text-slate-200">Verification</div>
              <Button onClick={() => setConfig((c) => ({ ...c, verification: { commands: [...c.verification.commands, { command: '' }] } }))}>
                <Plus className="h-4 w-4" /> Command
              </Button>
            </div>
            <div className="space-y-3">
              {config.verification.commands.length === 0 && (
                <div className="rounded-md border border-dashed border-[#262b38] px-3 py-4 text-sm text-slate-600">No commands</div>
              )}
              {config.verification.commands.map((command, index) => (
                <div key={index} className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_120px_110px_90px_36px]">
                  <Input
                    value={command.command}
                    onChange={(e) => updateCommand(setConfig, index, { command: e.target.value })}
                    placeholder="npm test"
                  />
                  <Input
                    value={command.cwd ?? ''}
                    onChange={(e) => updateCommand(setConfig, index, { cwd: e.target.value })}
                    placeholder="cwd"
                  />
                  <Input
                    type="number"
                    min={0}
                    value={command.timeout_ms ?? ''}
                    onChange={(e) => updateCommand(setConfig, index, { timeout_ms: optionalNumber(e.target.value) })}
                    placeholder="timeout"
                  />
                  <Select
                    value={command.on_failure ?? 'retry'}
                    onChange={(e) => updateCommand(setConfig, index, { on_failure: e.target.value as 'retry' | 'park' })}
                  >
                    <option value="retry">retry</option>
                    <option value="park">park</option>
                  </Select>
                  <Button
                    aria-label="Remove command"
                    className="justify-center px-0"
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        verification: { commands: c.verification.commands.filter((_, i) => i !== index) },
                      }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel className="p-4">
            <div className="mb-4 text-sm font-medium text-slate-200">Promotion</div>
            <div className="space-y-3">
              <Field label="Mode">
                <Select
                  value={config.promotion.mode}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      promotion: { ...c.promotion, mode: e.target.value as ProjectWorkflowConfig['promotion']['mode'] },
                    }))
                  }
                >
                  <option value="direct-merge">direct-merge</option>
                  <option value="pull-request">pull-request</option>
                </Select>
              </Field>
              <Field label="Base branch">
                <Input
                  value={config.promotion.base_branch ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, promotion: { ...c.promotion, base_branch: e.target.value } }))}
                  placeholder={project.default_branch}
                />
              </Field>
              <Field label="Remote">
                <Input
                  value={config.promotion.remote}
                  onChange={(e) => setConfig((c) => ({ ...c, promotion: { ...c.promotion, remote: e.target.value } }))}
                />
              </Field>
              <Field label="Auto merge">
                <Select
                  value={String(config.promotion.auto_merge)}
                  onChange={(e) => setConfig((c) => ({ ...c, promotion: { ...c.promotion, auto_merge: e.target.value === 'true' } }))}
                >
                  <option value="false">off</option>
                  <option value="true">on</option>
                </Select>
              </Field>
              <Field label="Check poll (ms)">
                <Input
                  type="number"
                  min={1000}
                  value={config.promotion.check_poll_interval_ms}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      promotion: { ...c.promotion, check_poll_interval_ms: optionalNumber(e.target.value) ?? DEFAULT_CONFIG.promotion.check_poll_interval_ms },
                    }))
                  }
                />
              </Field>
              <Field label="Check timeout (ms)">
                <Input
                  type="number"
                  min={0}
                  value={config.promotion.check_timeout_ms}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      promotion: { ...c.promotion, check_timeout_ms: optionalNumber(e.target.value) ?? DEFAULT_CONFIG.promotion.check_timeout_ms },
                    }))
                  }
                />
              </Field>
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="mb-4 text-sm font-medium text-slate-200">Commit Guard</div>
            <div className="space-y-3">
              <Field label="Enabled">
                <Select
                  value={String(config.commit_guard.enabled)}
                  onChange={(e) => setConfig((c) => ({ ...c, commit_guard: { ...c.commit_guard, enabled: e.target.value === 'true' } }))}
                >
                  <option value="false">off</option>
                  <option value="true">on</option>
                </Select>
              </Field>
              <Field label="Blocked untracked globs">
                <Textarea
                  rows={5}
                  value={config.commit_guard.blocked_untracked_globs.join('\n')}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      commit_guard: {
                        ...c.commit_guard,
                        blocked_untracked_globs: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
                      },
                    }))
                  }
                />
              </Field>
              <Field label="Max files">
                <Input
                  type="number"
                  min={0}
                  value={config.commit_guard.max_files ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, commit_guard: { ...c.commit_guard, max_files: optionalNumber(e.target.value) } }))}
                />
              </Field>
              <Field label="Max bytes">
                <Input
                  type="number"
                  min={0}
                  value={config.commit_guard.max_bytes ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, commit_guard: { ...c.commit_guard, max_bytes: optionalNumber(e.target.value) } }))}
                />
              </Field>
              <Field label="Override limits">
                <Select
                  value={String(config.commit_guard.override_limits)}
                  onChange={(e) => setConfig((c) => ({ ...c, commit_guard: { ...c.commit_guard, override_limits: e.target.value === 'true' } }))}
                >
                  <option value="false">off</option>
                  <option value="true">on</option>
                </Select>
              </Field>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function updateCommand(
  setConfig: (updater: (config: ProjectWorkflowConfig) => ProjectWorkflowConfig) => void,
  index: number,
  patch: Partial<VerificationCommandConfig>,
) {
  setConfig((config) => ({
    ...config,
    verification: {
      commands: config.verification.commands.map((command, i) => (i === index ? { ...command, ...patch } : command)),
    },
  }));
}

function normalizeConfig(value: unknown): ProjectWorkflowConfig {
  const raw = isRecord(value) ? value : {};
  const agent = isRecord(raw.agent) ? raw.agent : {};
  const prompts = isRecord(raw.prompts) ? raw.prompts : {};
  const verification = isRecord(raw.verification) ? raw.verification : {};
  const promotion = isRecord(raw.promotion) ? raw.promotion : {};
  const guard = isRecord(raw.commit_guard) ? raw.commit_guard : {};

  return {
    agent: {
      permission_mode: stringOrUndefined(agent.permission_mode),
      max_turns: numberOrUndefined(agent.max_turns),
      max_turns_by_phase: normalizePhaseTurns(agent.max_turns_by_phase ?? agent.max_turns),
    },
    prompts: {
      plan: stringOrUndefined(prompts.plan),
      implement: stringOrUndefined(prompts.implement),
      qa: stringOrUndefined(prompts.qa),
    },
    verification: {
      commands: Array.isArray(verification.commands)
        ? verification.commands.map(normalizeCommand).filter((c): c is VerificationCommandConfig => !!c)
        : [],
    },
    promotion: {
      mode: promotion.mode === 'pull-request' ? 'pull-request' : 'direct-merge',
      base_branch: stringOrUndefined(promotion.base_branch),
      remote: stringOrUndefined(promotion.remote) ?? DEFAULT_CONFIG.promotion.remote,
      auto_merge: typeof promotion.auto_merge === 'boolean' ? promotion.auto_merge : DEFAULT_CONFIG.promotion.auto_merge,
      check_poll_interval_ms: numberOrUndefined(promotion.check_poll_interval_ms) ?? DEFAULT_CONFIG.promotion.check_poll_interval_ms,
      check_timeout_ms: numberOrUndefined(promotion.check_timeout_ms) ?? DEFAULT_CONFIG.promotion.check_timeout_ms,
    },
    commit_guard: {
      enabled: typeof guard.enabled === 'boolean' ? guard.enabled : DEFAULT_CONFIG.commit_guard.enabled,
      blocked_untracked_globs: Array.isArray(guard.blocked_untracked_globs)
        ? guard.blocked_untracked_globs.map((g) => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)
        : [...DEFAULT_CONFIG.commit_guard.blocked_untracked_globs],
      max_files: numberOrUndefined(guard.max_files),
      max_bytes: numberOrUndefined(guard.max_bytes),
      override_limits: typeof guard.override_limits === 'boolean' ? guard.override_limits : DEFAULT_CONFIG.commit_guard.override_limits,
    },
  };
}

function sanitizeConfig(config: ProjectWorkflowConfig): ProjectWorkflowConfig {
  return normalizeConfig({
    ...config,
    prompts: {
      plan: blankToUndefined(config.prompts.plan),
      implement: blankToUndefined(config.prompts.implement),
      qa: blankToUndefined(config.prompts.qa),
    },
    verification: {
      commands: config.verification.commands
        .map((command) => ({
          command: command.command.trim(),
          cwd: blankToUndefined(command.cwd),
          timeout_ms: command.timeout_ms,
          on_failure: command.on_failure ?? 'retry',
        }))
        .filter((command) => command.command),
    },
    promotion: {
      ...config.promotion,
      base_branch: blankToUndefined(config.promotion.base_branch),
      remote: config.promotion.remote.trim() || DEFAULT_CONFIG.promotion.remote,
    },
  });
}

function normalizeCommand(value: unknown): VerificationCommandConfig | null {
  if (typeof value === 'string') return value.trim() ? { command: value.trim() } : null;
  if (!isRecord(value)) return null;
  const command = stringOrUndefined(value.command);
  if (!command) return null;
  return {
    command,
    cwd: stringOrUndefined(value.cwd),
    timeout_ms: numberOrUndefined(value.timeout_ms),
    on_failure: value.on_failure === 'park' ? 'park' : 'retry',
  };
}

function normalizePhaseTurns(value: unknown): Partial<Record<ProjectRunPhase, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<ProjectRunPhase, number>> = {};
  for (const phase of PHASES) {
    const turns = numberOrUndefined(value[phase]);
    if (turns !== undefined) out[phase] = turns;
  }
  return Object.keys(out).length ? out : undefined;
}

function setPhaseTurns(
  current: Partial<Record<ProjectRunPhase, number>> | undefined,
  phase: ProjectRunPhase,
  value: number | undefined,
) {
  const next = { ...(current ?? {}) };
  if (value === undefined) delete next[phase];
  else next[phase] = value;
  return Object.keys(next).length ? next : undefined;
}

function optionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function blankToNull(value: string): string | null {
  return value.trim() ? value : null;
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
