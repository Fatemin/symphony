import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Paperclip, Upload, X } from 'lucide-react';
import type { Attachment } from '../../shared/types';
import { api, attachmentUrl } from '../api';

// SYM-35: reusable paste / drag-drop / file-picker attachment control. Controlled — the parent owns
// the list of uploaded `Attachment`s and decides when to link them (issue/ask create) or, when an
// `issueId` is supplied, uploads auto-link to that issue server-side. Each file uploads as soon as it
// is added; the parent only ever holds ids. Handles every UI state: empty hint, per-file uploading
// spinner, success thumbnail/chip, dismissible per-file error, disabled, and keyboard focus.

const DEFAULT_MAX = 10;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // mirrors the engine default max_attachment_bytes

interface Pending {
  key: number;
  name: string;
  error?: string;
}

interface AttachmentInputProps {
  projectId: string;
  /** When set, uploads pre-link to this issue (the edit flow); omit for create/ask (link on submit). */
  issueId?: string;
  value: Attachment[];
  onChange: (next: Attachment[]) => void;
  disabled?: boolean;
  /** Max number of attachments (defaults to the engine's per-item cap). */
  max?: number;
  maxBytes?: number;
}

const isImage = (mime: string) => mime.startsWith('image/');

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentInput({
  projectId,
  issueId,
  value,
  onChange,
  disabled = false,
  max = DEFAULT_MAX,
  maxBytes = DEFAULT_MAX_BYTES,
}: AttachmentInputProps) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const activeCount = value.length + pending.filter((p) => !p.error).length;

  const addFiles = (files: File[]) => {
    if (disabled || files.length === 0) return;
    let remaining = max - activeCount;
    const accepted: { file: File; key: number }[] = [];
    const errors: Pending[] = [];
    for (const file of files) {
      if (remaining <= 0) {
        errors.push({ key: nextKey.current++, name: file.name || 'file', error: `Limit is ${max} attachments` });
        break;
      }
      if (file.size > maxBytes) {
        errors.push({
          key: nextKey.current++,
          name: file.name || 'file',
          error: `Too large (max ${formatBytes(maxBytes)})`,
        });
        continue;
      }
      accepted.push({ file, key: nextKey.current++ });
      remaining -= 1;
    }
    if (accepted.length || errors.length) {
      setPending((prev) => [...prev, ...errors, ...accepted.map((a) => ({ key: a.key, name: a.file.name || 'file' }))]);
    }
    for (const { file, key } of accepted) void upload(file, key);
  };

  const upload = async (file: File, key: number) => {
    try {
      const attachment = await api.attachments.upload({ file, projectId, issueId });
      setPending((prev) => prev.filter((p) => p.key !== key));
      onChange([...value, attachment]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPending((prev) => prev.map((p) => (p.key === key ? { ...p, error: message } : p)));
    }
  };

  const remove = async (att: Attachment) => {
    onChange(value.filter((a) => a.id !== att.id)); // optimistic
    try {
      await api.attachments.remove(att.id);
    } catch (e) {
      toast.error(`Could not remove ${att.filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div className={disabled ? 'pointer-events-none opacity-60' : undefined}>
      {/* Dropzone — focusable so paste (⌘V) targets it; also accepts drag-drop and opens the picker. */}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Add attachments: click to choose files, or focus and paste"
        onPaste={onPaste}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        // SYM-73: drop the hand-rolled ring (inherits the global :focus-visible ring on this large
        // dropzone) and route the dragging/hover accent border + fill + label through --color-accent.
        className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs transition-colors ${
          dragging ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent-hover)]' : 'border-border bg-bg-2 text-muted hover:border-[var(--color-accent)]/50 hover:text-fg'
        }`}
      >
        {dragging ? <Upload className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
        <span>
          {dragging ? 'Drop to attach' : 'Paste, drop, or '}
          {!dragging && <span className="font-medium text-[var(--color-accent-hover)]">choose files</span>}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files to attach"
        disabled={disabled}
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = ''; // allow re-picking the same file
        }}
      />

      {(value.length > 0 || pending.length > 0) && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {value.map((att) => (
            <li key={att.id}>
              <AttachmentChip att={att} disabled={disabled} onRemove={() => remove(att)} />
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key}>
              <PendingChip pending={p} onDismiss={() => setPending((prev) => prev.filter((x) => x.key !== p.key))} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentChip({ att, disabled, onRemove }: { att: Attachment; disabled: boolean; onRemove: () => void }) {
  const image = isImage(att.mime);
  return (
    <div className="group relative flex items-center gap-2 rounded-md border border-border bg-panel-2 py-1 pl-1 pr-7 text-xs text-fg">
      {image ? (
        <img
          src={attachmentUrl(att.id)}
          alt={att.filename}
          className="h-9 w-9 shrink-0 rounded object-cover"
          loading="lazy"
        />
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-bg-2 text-muted">
          <FileText className="h-4 w-4" />
        </span>
      )}
      <div className="min-w-0 max-w-[10rem]">
        <a
          href={attachmentUrl(att.id, true)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="block truncate font-medium hover:text-indigo-300"
          title={att.filename}
        >
          {att.filename}
        </a>
        <span className="text-[10px] text-subtle">{formatBytes(att.size_bytes)}</span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${att.filename}`}
        disabled={disabled}
        onClick={onRemove}
        className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function PendingChip({ pending, onDismiss }: { pending: Pending; onDismiss: () => void }) {
  if (pending.error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 py-1.5 pl-2 pr-1.5 text-xs text-[var(--color-danger)]">
        <span className="min-w-0 max-w-[12rem] truncate" title={`${pending.name}: ${pending.error}`}>
          <span className="font-medium">{pending.name}</span> — {pending.error}
        </span>
        <button
          type="button"
          aria-label={`Dismiss error for ${pending.name}`}
          onClick={onDismiss}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-danger)] hover:bg-[var(--color-danger)]/20"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-panel-2 py-1.5 px-2 text-xs text-muted">
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      <span className="min-w-0 max-w-[10rem] truncate" title={pending.name}>
        {pending.name}
      </span>
    </div>
  );
}
