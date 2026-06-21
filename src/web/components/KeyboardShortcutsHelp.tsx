import { Keyboard } from 'lucide-react';
import { Modal, cn } from './ui';

// SYM-82: the single source of truth for the app's keyboard contract. The help overlay renders this
// table; the global listener in Layout.tsx implements the same combos, so the two can't drift. A
// `combo` is one key sequence (rendered as joined <kbd>s); `alt` is an optional equivalent (e.g. the
// Windows/Linux Ctrl chord shown next to the macOS ⌘ chord).
export interface ShortcutRow {
  combo: string[];
  alt?: string[];
  description: string;
}
export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Global',
    rows: [
      { combo: ['⌘', 'K'], alt: ['Ctrl', 'K'], description: 'Open the command palette' },
      { combo: ['?'], description: 'Show this shortcuts overlay' },
      { combo: ['Esc'], description: 'Close the palette or any open dialog' },
    ],
  },
  {
    title: 'Command palette',
    rows: [
      { combo: ['↑'], alt: ['↓'], description: 'Move between results (wraps at the ends)' },
      { combo: ['Enter'], description: 'Run the highlighted command' },
      { combo: ['Esc'], description: 'Dismiss the palette' },
    ],
  },
];

/** A single keycap, styled from the design tokens (no new tokens). Reused by the palette footer. */
export function Kbd({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-grid min-w-[1.5rem] place-items-center rounded border border-border bg-panel-2 px-1.5 py-0.5',
        'font-sans text-[11px] font-medium leading-none text-fg shadow-[var(--elev-1)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Renders one key sequence as joined keycaps (e.g. ⌘ + K). */
function Combo({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-subtle">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * The keyboard-shortcuts overlay (SYM-82). Built on the shared centered `Modal` (focus-trap, Escape,
 * backdrop-click, scroll-lock, focus restore), opened by the global `?` listener and the palette's
 * "Keyboard shortcuts" command. Pure presentation over the SHORTCUTS const.
 */
export function KeyboardShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      size="md"
      onClose={onClose}
      icon={<Keyboard className="h-4 w-4 text-indigo-300" />}
      title="Keyboard shortcuts"
    >
      <div className="space-y-5">
        {SHORTCUTS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
              {group.title}
            </h3>
            <dl className="space-y-1.5">
              {group.rows.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <dt className="min-w-0 text-sm text-muted">{row.description}</dt>
                  <dd className="flex shrink-0 items-center gap-1.5">
                    <Combo keys={row.combo} />
                    {row.alt && (
                      <>
                        <span className="text-xs text-subtle">or</span>
                        <Combo keys={row.alt} />
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
