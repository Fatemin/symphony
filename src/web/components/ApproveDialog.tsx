import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, GitBranch, Plus } from 'lucide-react';
import { api, type ApproveOptions } from '../api';
import { Button, Field, Input, Modal, Spinner } from './ui';

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
  // Mid-approve the dialog can't be dismissed (matches the disabled controls), so Escape / backdrop /
  // the close button all no-op while pending.
  const close = () => {
    if (!pending) onCancel();
  };

  return (
    <Modal
      onClose={close}
      size="sm"
      icon={<GitBranch className="h-4 w-4 text-indigo-300" />}
      title={`Approve ${count === 1 ? 'story' : `${count} stories`}`}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!trimmed || pending}
            onClick={() => onConfirm({ target_branch: trimmed, create_branch: createBranch, set_default_branch: setDefault })}
          >
            {pending ? <Spinner /> : <Check className="h-4 w-4" />} Approve
          </Button>
        </>
      }
    >
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
    </Modal>
  );
}
