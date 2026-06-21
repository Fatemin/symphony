import { useCallback, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, RotateCcw, X } from 'lucide-react';
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * SYM-59: the single class-composition helper. clsx resolves conditionals; tailwind-merge then
 * de-duplicates conflicting Tailwind utilities so a primitive's defaults can always be overridden by
 * a call site's `className` (last write wins) instead of both classes fighting in the cascade.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  // text-white stays on the accent/danger fills — those read against indigo/red (AA) in both themes.
  primary: 'bg-indigo-600 hover:bg-indigo-500 text-white',
  subtle: 'bg-panel-2 hover:bg-hover text-fg border border-border',
  ghost: 'hover:bg-panel-2 text-fg',
  danger: 'bg-red-600/90 hover:bg-red-500 text-white',
};

// `md` reproduces the historical button metrics (px-3 py-1.5 text-sm gap-1.5); `sm` is the compact
// inline variant. Every interactive element inherits the @layer base :focus-visible ring.
const SIZES: Record<Size, string> = {
  sm: 'gap-1 px-2 py-1 text-xs',
  md: 'gap-1.5 px-3 py-1.5 text-sm',
};

export function Button({
  variant = 'subtle',
  size = 'md',
  loading = false,
  className = '',
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center rounded-md font-medium transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50',
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner className="-ml-0.5" />}
      {children}
    </button>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

// SYM-59: token-driven badge tones. The subtle surface is derived from the semantic foreground token
// via color-mix, so each tone re-themes automatically (light/dark) from one source. `neutral` adds no
// color so existing call sites that pass their own bg/text className keep working unchanged.
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: '',
  accent: 'bg-[color-mix(in_oklab,var(--color-accent)_16%,transparent)] text-[var(--color-accent-hover)]',
  success: 'bg-[color-mix(in_oklab,var(--color-success)_16%,transparent)] text-[var(--color-success)]',
  warning: 'bg-[color-mix(in_oklab,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]',
  danger: 'bg-[color-mix(in_oklab,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]',
  info: 'bg-[color-mix(in_oklab,var(--color-info)_16%,transparent)] text-[var(--color-info)]',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Panel({
  children,
  className = '',
  interactive = false,
  elevated = false,
}: {
  children: ReactNode;
  className?: string;
  /** Adds the hover affordance for clickable cards (border highlight + color transition). */
  interactive?: boolean;
  /** Lifts the panel off the page with the level-2 elevation shadow (drawers, popovers). */
  elevated?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-panel',
        elevated && 'shadow-[var(--elev-2)]',
        interactive && 'transition-colors hover:border-[var(--color-accent)]/60',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  /** Renders a danger-tinted asterisk after the label (the control still carries `required` for SRs). */
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">
        {label}
        {required && (
          <span aria-hidden className="text-[var(--color-danger)]"> *</span>
        )}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

// SYM-59: a real keyboard-visible focus ring (was border-only) plus disabled + aria-invalid states,
// all token-driven. `outline-none` suppresses the @layer base global ring so only this ring shows.
const inputClass =
  'w-full rounded-md border border-border bg-bg-2 px-3 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-subtle ' +
  'focus-visible:border-[var(--color-ring)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]/35 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-[invalid=true]:border-[var(--color-danger)] aria-[invalid=true]:focus-visible:ring-[var(--color-danger)]/35';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputClass, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(inputClass, 'cursor-pointer', props.className)} />;
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none',
        className,
      )}
    />
  );
}

/** Centered spinner + label — the standard page/section loading affordance. */
export function Loading({ label = 'Loading…', className = '' }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center justify-center gap-2 p-8 text-sm text-muted', className)}
    >
      <Spinner /> {label}
    </div>
  );
}

/** Shimmer placeholder for content-shaped loading; honours prefers-reduced-motion. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-panel-2 motion-reduce:animate-none', className)} />;
}

/** The square colour-keyed project badge reused in every project header. */
export function ProjectChip({
  color,
  children,
  className = '',
}: {
  color: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn('grid h-7 w-7 shrink-0 place-items-center rounded text-xs font-bold', className)}
      style={{ background: color + '33', color }}
    >
      {children}
    </span>
  );
}

/**
 * SYM-59: the standard page header — back affordance, leading icon/chip, title + optional subtitle,
 * a trailing badge slot, and right-aligned actions. Standardises spacing so pages stop diverging.
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  badge,
  back,
  actions,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  back?: { to: string; label?: string };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {back && (
          <Link
            to={back.to}
            aria-label={back.label ?? 'Back'}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        )}
        {icon}
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight sm:text-xl">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
          {badge}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Empty / zero-data state — icon, title, supporting copy, optional call to action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Panel className={cn('flex flex-col items-center gap-2 px-6 py-10 text-center', className)}>
      {icon && <div className="text-muted [&_svg]:h-6 [&_svg]:w-6">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="max-w-md text-sm leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Panel>
  );
}

/** Error state with a clear recovery path (retry) — used for failed queries. */
export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <Panel
      className={cn(
        'flex flex-col items-center gap-2 border-[var(--color-danger)]/30 bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-6 py-8 text-center',
        className,
      )}
    >
      <AlertTriangle className="h-6 w-6 text-[var(--color-danger)]" />
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="max-w-md text-sm leading-relaxed text-muted">{description}</p>}
      {onRetry && (
        <Button className="mt-2" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" /> Retry
        </Button>
      )}
    </Panel>
  );
}

/**
 * SYM-59: native-<dialog> lifecycle hook shared by Modal and the Ask drawer. showModal() on mount
 * gives focus-trap + a top-layer surface (escapes the .anim-page-in transform containing block) + the
 * ::backdrop for free; close() in cleanup (run before unmount) restores focus to the trigger. Escape
 * is routed through React via onCancel so `open` state stays the single source of truth.
 */
export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // scroll-lock the page behind the modal
    return () => {
      document.body.style.overflow = prevOverflow;
      if (dlg.open) dlg.close(); // runs while still mounted ⇒ browser restores focus to the opener
    };
  }, []);
  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault(); // suppress the UA close; let React unmount via onClose
      onClose();
    },
    [onClose],
  );
  return { ref, handleCancel };
}

const MODAL_SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

/**
 * Centered modal dialog. Mount it while open (`{open && <Modal …>}`); it self-manages showModal /
 * Escape / backdrop-click / focus restore. Provides a standard header (icon + title + close) and an
 * optional footer; the body slot scrolls when tall.
 */
export function Modal({
  onClose,
  title,
  icon,
  size = 'md',
  children,
  footer,
  className = '',
  'aria-label': ariaLabel,
}: {
  onClose: () => void;
  title?: ReactNode;
  icon?: ReactNode;
  size?: keyof typeof MODAL_SIZES;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  const { ref, handleCancel } = useModalDialog(onClose);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the ::backdrop reports the <dialog> as target
      }}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel}
      className={cn(
        'anim-modal-in m-auto w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-panel p-0 text-fg shadow-[var(--elev-3)] backdrop:bg-black/60',
        MODAL_SIZES[size],
        className,
      )}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
            {icon}
            <span className="truncate">{title}</span>
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
      )}
      <div className="max-h-[70dvh] overflow-y-auto px-4 py-4">{children}</div>
      {footer && (
        <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>
      )}
    </dialog>
  );
}
