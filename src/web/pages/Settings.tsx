import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type EngineConfig } from '../api';
import { Button, Field, Input, Panel, Select } from '../components/ui';
import { AVAILABLE_MODELS } from '../../shared/models';

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

  if (!form) return <div className="p-8 text-sm text-muted">Loading…</div>;
  const set = (k: keyof EngineConfig, v: unknown) => setForm({ ...form, [k]: v });

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-muted">Engine configuration. Changes apply to future dispatches.</p>

      <Panel className="space-y-4 p-5">
        <div className="flex items-center justify-between rounded-md bg-bg-2 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Orchestrator enabled</p>
            <p className="text-xs text-muted">Master switch for auto-dispatch.</p>
          </div>
          <Select value={String(form.enabled)} onChange={(e) => set('enabled', e.target.value === 'true')} className="w-auto">
            <option value="true">on</option>
            <option value="false">off</option>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Model">
            <Select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {!AVAILABLE_MODELS.some((m) => m.id === form.model) && (
                <option value={form.model}>{form.model} (custom)</option>
              )}
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Permission mode">
            <Select value={form.permission_mode} onChange={(e) => set('permission_mode', e.target.value)}>
              <option value="bypassPermissions">bypassPermissions</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="default">default</option>
              <option value="plan">plan</option>
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
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(coerce(form))}>
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
