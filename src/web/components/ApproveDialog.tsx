import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, GitBranch, Plus, X } from 'lucide-react';
import { api, type ApproveOptions } from '../api';
import { Button, Field, Input, Spinner } from './ui';

export function ApproveDialog({
  projectId,
  initialBranch,
  count,
  pending,
  onCancel,
  onConfirm,
}: {
  projectId: string;
  initialBranch: string;
  count: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (options: ApproveOptions) => void;
}) {
  const { data } = useQuery({
    queryKey: ['branches', projectId],
    queryFn: () => api.projects.branches(projectId),
  });
  const [branch, setBranch] = useState(initialBranch);
  const [createBranch, setCreateBranch] = useState(false);
  const [setDefault, setSetDefault] = useState(false);
  const branches = data?.branches ?? [];
  const trimmed = branch.trim();
  const exists = branches.includes(trimmed);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-panel p-4 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-indigo-300" />
            <h2 className="text-sm font-semibold">Approve {count === 1 ? 'story' : `${count} stories`}</h2>
          </div>
          <Button variant="ghost" className="px-2" onClick={onCancel} disabled={pending}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3">
          <Field label="Merge target">
            <>
              <Input
                list={`branches-${projectId}`}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={data?.default_branch ?? 'main'}
                autoFocus
              />
              <datalist id={`branches-${projectId}`}>
                {branches.map((name) => <option key={name} value={name} />)}
              </datalist>
            </>
          </Field>

          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="h-4 w-4 accent-indigo-500"
              checked={createBranch}
              disabled={exists}
              onChange={(e) => setCreateBranch(e.target.checked)}
            />
            <Plus className="h-3.5 w-3.5 text-muted" />
            Create branch
          </label>

          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="h-4 w-4 accent-indigo-500"
              checked={setDefault}
              onChange={(e) => setSetDefault(e.target.checked)}
            />
            Set as default
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={pending}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!trimmed || pending}
            onClick={() => onConfirm({ target_branch: trimmed, create_branch: createBranch, set_default_branch: setDefault })}
          >
            {pending ? <Spinner /> : <Check className="h-4 w-4" />} Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
