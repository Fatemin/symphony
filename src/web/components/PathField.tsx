import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Check, Folder, FolderGit2, FolderOpen, GitBranch, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { FsValidate } from '../api';
import { Button, Input } from './ui';

/**
 * Server-backed directory picker. The browser can't get an absolute folder path
 * from its own file dialog, so this navigates the *server's* filesystem (this is
 * a localhost tool) and returns an absolute path the runner can use.
 */
function DirectoryPicker({
  open,
  initialPath,
  onClose,
  onSelect,
}: {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [cwd, setCwd] = useState<string | undefined>(initialPath || undefined);

  // Re-anchor on the field's current value each time the picker opens.
  useEffect(() => {
    if (open) setCwd(initialPath || undefined);
  }, [open, initialPath]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['fs-browse', cwd ?? '~'],
    queryFn: () => api.fs.browse(cwd),
    enabled: open,
  });

  if (!open) return null;
  const current = data?.path ?? cwd ?? '~';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-lg border border-[#262b38] bg-[#14171f] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-slate-200">Choose project folder</h2>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="subtle"
              className="px-2"
              disabled={!data?.parent}
              onClick={() => data?.parent && setCwd(data.parent)}
              title="Up one level"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <code
              className="flex-1 truncate rounded-md border border-[#262b38] bg-[#0f1218] px-2 py-1.5 text-xs text-slate-400"
              title={current}
            >
              {current}
            </code>
          </div>

          <div className="h-64 overflow-y-auto rounded-md border border-[#262b38] bg-[#0f1218]">
            {isLoading && (
              <div className="flex h-full items-center justify-center text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {isError && (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-red-400">
                Can't read this folder.
              </div>
            )}
            {data && !isLoading && (
              data.entries.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  No sub-folders here
                </div>
              ) : (
                <ul className="divide-y divide-[#262b38]">
                  {data.entries.map((e) => (
                    <li key={e.path}>
                      <button
                        type="button"
                        onClick={() => setCwd(e.path)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-300 hover:bg-[#1b1f2a] hover:text-slate-100"
                      >
                        {e.isGitRepo ? (
                          <FolderGit2 className="h-[15px] w-[15px] shrink-0 text-indigo-400" />
                        ) : (
                          <Folder className="h-[15px] w-[15px] shrink-0 text-slate-500" />
                        )}
                        <span className="flex-1 truncate">{e.name}</span>
                        {e.isGitRepo && <span className="shrink-0 text-[10px] font-medium text-indigo-400">git</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs">
            {data?.isGitRepo ? (
              <>
                <GitBranch className="h-3.5 w-3.5 text-green-500" />
                <span className="text-slate-400">This folder is a git repository</span>
              </>
            ) : (
              <span className="text-slate-500">This folder is not a git repository (agents need one to run)</span>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!data?.path}
            onClick={() => {
              if (data?.path) {
                onSelect(data.path);
                onClose();
              }
            }}
          >
            <Check className="h-3.5 w-3.5" /> Use this folder
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Absolute-path input for a project's repo_path: a text field with a "Browse…"
 * button (server-backed DirectoryPicker) and a live validation hint (exists /
 * is a directory / is a git repo). A missing repo is a warning, not an error.
 */
export function PathField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState<FsValidate | null>(null);

  // Debounced validation as the user types or after a pick.
  useEffect(() => {
    if (!value.trim()) {
      setStatus(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api.fs
        .validate(value)
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {
          if (alive) setStatus(null);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          className="flex-1 font-mono text-xs"
          placeholder={placeholder ?? '/Users/you/projects/my-app'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button variant="subtle" className="shrink-0" onClick={() => setPickerOpen(true)}>
          <FolderOpen className="h-3.5 w-3.5" /> Browse
        </Button>
      </div>

      {status && (
        <p
          className={`text-[11px] ${
            status.ok ? (status.isGitRepo ? 'text-green-500' : 'text-amber-500') : 'text-red-400'
          }`}
        >
          {status.ok ? (status.isGitRepo ? '✓ git repository' : `⚠ ${status.warning}`) : `✗ ${status.error}`}
        </p>
      )}

      <DirectoryPicker
        open={pickerOpen}
        initialPath={value}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => onChange(p)}
      />
    </div>
  );
}
