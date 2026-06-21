import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, THINKING_EFFORT_OPTIONS, type EngineConfig } from '../api';
import { Button, Field, Input, Loading, PageHeader, Panel, Select } from '../components/ui';
import { AGENT_OPTIONS, AVAILABLE_MODELS } from '../../shared/models';

const NUMERIC: (keyof EngineConfig)[] = [
  'wip_limit',
  'poll_interval_ms',
  'phase_timeout_ms',
  'stall_timeout_ms',
  'max_turns',
  'max_attempts',
  'max_retry_backoff_ms',
];

export function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.ops.getSettings });
  const [form, setForm] = useState<EngineConfig | null>(null);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const save = useMutation({
    mutationFn: (patch: Partial<EngineConfig>) => api.ops.updateSettings(patch),
    onSuccess: (cfg) => { setForm(cfg); qc.invalidateQueries({ queryKey: ['settings'] }); toast.success('Settings saved'); },
    onError: (e) => toast.error(String(e)),
  });

  if (!form) return <Loading />;
  const set = (k: keyof EngineConfig, v: unknown) => setForm({ ...form, [k]: v });

  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <PageHeader title="Settings" subtitle="Engine configuration. Changes apply to future dispatches." />

      <Panel className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3 rounded-md bg-bg-2 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Orchestrator enabled</p>
            <p className="text-xs text-muted">Master switch for auto-dispatch.</p>
          </div>
          <Select value={String(form.enabled)} onChange={(e) => set('enabled', e.target.value === 'true')} className="w-auto">
            <option value="true">on</option>
            <option value="false">off</option>
          </Select>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Default agent">
            <Select value={form.agent ?? 'claude'} onChange={(e) => set('agent', e.target.value)}>
              {AGENT_OPTIONS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Model (Claude)">
            <Select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {!AVAILABLE_MODELS.some((m) => m.id === form.model) && (
                <option value={form.model}>{form.model} (custom)</option>
              )}
              {AVAILABLE_MODELS.filter((m) => m.agent !== 'codex').map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Codex model">
            <Select value={form.codex_model ?? ''} onChange={(e) => set('codex_model', e.target.value)}>
              {!AVAILABLE_MODELS.some((m) => m.id === form.codex_model) && (
                <option value={form.codex_model ?? ''}>{form.codex_model || '(custom)'}</option>
              )}
              {AVAILABLE_MODELS.filter((m) => m.agent === 'codex').map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Codex CLI path">
            <Input value={String(form.codex_cli_path ?? '')} onChange={(e) => set('codex_cli_path', e.target.value)} />
          </Field>
          <Field label="Permission mode">
            <Select value={form.permission_mode} onChange={(e) => set('permission_mode', e.target.value)}>
              <option value="bypassPermissions">bypassPermissions</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="default">default</option>
              <option value="plan">plan</option>
            </Select>
          </Field>
          <Field label="Workflow tool">
            <Select
              value={String(form.enable_workflow_tool ?? false)}
              onChange={(e) => set('enable_workflow_tool', e.target.value === 'true')}
            >
              <option value="false">off</option>
              <option value="true">on (allow self-spawned runs)</option>
            </Select>
          </Field>
          <Field label="Thinking effort">
            <Select value={form.thinking_effort ?? 'none'} onChange={(e) => set('thinking_effort', e.target.value)}>
              {THINKING_EFFORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="WIP limit (max concurrent)">
            <Input type="number" value={form.wip_limit} onChange={(e) => set('wip_limit', Number(e.target.value))} />
          </Field>
          <Field label="Poll interval (ms)">
            <Input type="number" value={form.poll_interval_ms} onChange={(e) => set('poll_interval_ms', Number(e.target.value))} />
          </Field>
          <Field label="Max turns / phase">
            <Input type="number" value={form.max_turns} onChange={(e) => set('max_turns', Number(e.target.value))} />
          </Field>
          <Field label="Max attempts">
            <Input type="number" value={form.max_attempts} onChange={(e) => set('max_attempts', Number(e.target.value))} />
          </Field>
          <Field label="Phase timeout (ms)">
            <Input type="number" value={form.phase_timeout_ms} onChange={(e) => set('phase_timeout_ms', Number(e.target.value))} />
          </Field>
          <Field label="Stall timeout (ms)">
            <Input type="number" value={form.stall_timeout_ms} onChange={(e) => set('stall_timeout_ms', Number(e.target.value))} />
          </Field>
        </div>

        <Field label="Workspace root (where worktrees are created)">
          <Input value={form.workspace_root} onChange={(e) => set('workspace_root', e.target.value)} />
        </Field>

        <div className="flex justify-end pt-2">
          <Button variant="primary" disabled={save.isPending} loading={save.isPending} onClick={() => save.mutate(coerce(form))}>
            Save
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/** Ensure numeric fields are numbers before sending. */
function coerce(form: EngineConfig): EngineConfig {
  const out = { ...form };
  for (const k of NUMERIC) (out[k] as number) = Number(out[k]);
  return out;
}
