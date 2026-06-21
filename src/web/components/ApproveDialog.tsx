import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, GitBranch, Plus } from 'lucide-react';
import { api, type ApproveOptions } from '../api';
import { Button, cn, Field, Input, Modal, PendingIndicator, Spinner } from './ui';

/**
 * SYM-81: the shared approve/merge confirm. Contextual (a source→target merge summary +
 * create-branch feedback), recoverable (an inline `error` region that keeps the dialog open on a
 * failed merge), and honest about long waits (a footer PendingIndicator with live elapsed seconds
 * while a merge runs). All three new props are optional, so the unchanged Board/IssueDetail contract
 * still type-checks.
 *
 * `sourceBranch` distinguishes the two call sites: single-issue (IssueDetail) passes the issue's
 * branch and renders `Merge <source> → <target>`; the batch path (Board) omits it and renders
 * `Merge N stories into <target>`. `pendingLabel` lets the batch path narrate "Approving N of M…".
 * `error` carries a server reason (single) or a multi-line per-issue failure list (batch).
 */
export function ApproveDialog({
  projectId,
  initialBranch,
  count,
  pending,
  sourceBranch,
  pendingLabel = 'Merging…',
  error,
  onCancel,
  onConfirm,
}: {
  projectId: string;
  initialBranch: string;
  count: number;
  pending: boolean;
  sourceBranch?: string | null;
  pendingLabel?: string;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (options: ApproveOptions) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['branches', projectId],
    queryFn: () => api.projects.branches(projectId),
  });
  const [branch, setBranch] = useState(initialBranch);
  const [createBranch, setCreateBranch] = useState(false);
  const [setDefault, setSetDefault] = useState(false);
  const branches = data?.branches ?? [];
  const trimmed = branch.trim();
  const exists = branches.includes(trimmed);
  const fallbackBranch = data?.default_branch ?? 'main';
  const targetLabel = trimmed || fallbackBranch;
  const stateId = `branch-state-${projectId}`;

  // Pre-submit echo of the server's create_branch 409 (issues.ts:200): tell the user what this merge
  // target resolves to BEFORE they click Approve. While branches are still loading we can't know if a
  // branch exists, so don't flash a false "doesn't exist" danger.
  let stateMsg = '';
  let stateTone = 'text-muted';
  if (trimmed) {
    if (isLoading) {
      stateMsg = 'Checking branches…';
    } else if (exists) {
      stateMsg = 'Merges into existing branch';
    } else if (createBranch) {
      // The server forks a brand-new target from the base/default branch (ensureBranch's `fromBranch`
      // = issue.base_branch ?? default_branch), NOT from the feature branch — so name `initialBranch`
      // (the base/default target both call sites pass in), never `sourceBranch`.
      stateMsg = `Will create ${targetLabel} from ${initialBranch || fallbackBranch}`;
    } else {
      stateMsg = "Branch doesn't exist — enable Create branch to create it";
      stateTone = 'text-[var(--color-danger)]';
    }
  }

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
          {/* mr-auto keeps Cancel/Approve right-aligned in the `justify-end` footer while the live
              elapsed counter (the reduced-motion activity signal) sits at the left. */}
          {pending && <PendingIndicator label={pendingLabel} className="mr-auto" />}
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
        <p className="text-sm text-muted">
          {sourceBranch ? (
            <>
              Merge <span className="font-mono text-fg">{sourceBranch}</span> →{' '}
              <span className="font-mono text-fg">{targetLabel}</span>
            </>
          ) : (
            <>
              Merge {count === 1 ? '1 story' : `${count} stories`} into{' '}
              <span className="font-mono text-fg">{targetLabel}</span>
            </>
          )}
        </p>

        <Field label="Merge target">
          <>
            <Input
              list={`branches-${projectId}`}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={data?.default_branch ?? 'main'}
              aria-describedby={stateMsg ? stateId : undefined}
              autoFocus
            />
            <datalist id={`branches-${projectId}`}>
              {branches.map((name) => <option key={name} value={name} />)}
            </datalist>
            {stateMsg && (
              <p id={stateId} role="alert" className={cn('mt-1 text-xs', stateTone)}>
                {stateMsg}
              </p>
            )}
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

        <div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="h-4 w-4 accent-indigo-500"
              checked={setDefault}
              onChange={(e) => setSetDefault(e.target.checked)}
            />
            Set as default
          </label>
          <p className="ml-6 mt-0.5 text-xs text-muted">
            Make {targetLabel} this project&apos;s default merge target
          </p>
        </div>

        {/* Recoverable failure: a 409 conflict / divergence (single) or a per-issue failure list
            (batch) keeps the dialog open so the user can adjust the target and retry. */}
        {error && (
          <div
            role="alert"
            className="whitespace-pre-line rounded-md border border-[var(--color-danger)]/30 bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
