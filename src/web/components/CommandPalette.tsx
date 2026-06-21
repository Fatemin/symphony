import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  CircleDot,
  Columns3,
  CornerDownLeft,
  FileText,
  Keyboard,
  Layers3,
  Network,
  Plus,
  ScanSearch,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  SunMoon,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { filterCommands, type Command, type CommandGroup } from '../lib/commandPalette';
import { Kbd } from './KeyboardShortcutsHelp';
import { cn, useModalDialog } from './ui';

// iconKey → lucide icon. The pure helper emits string keys (it imports no React); the mapping to an
// actual glyph lives here, in the view layer. Project-tab keys mirror ProjectTabs.tsx exactly.
const ICONS: Record<string, LucideIcon> = {
  'new-issue': Plus,
  theme: SunMoon,
  kick: Zap,
  shortcuts: Keyboard,
  projects: Layers3,
  ops: Activity,
  settings: SettingsIcon,
  issue: CircleDot,
  'tab:board': Columns3,
  'tab:agent': Bot,
  'tab:review': ScanSearch,
  'tab:story-tree': Network,
  'tab:docs': FileText,
  'tab:skills': Sparkles,
};

// Only the curated empty-query default set is shown under group headers; an active search renders a
// single flat ranked list (best match first) so a strong hit is never buried beneath a higher group.
const GROUP_ORDER: CommandGroup[] = ['actions', 'navigation', 'projects', 'issues'];
const GROUP_LABEL: Record<CommandGroup, string> = {
  actions: 'Actions',
  navigation: 'Go to',
  projects: 'Projects',
  issues: 'Issues',
};

/** A header row or an option row, with the option's flat index for aria-activedescendant. */
type Row = { kind: 'header'; key: string; label: string } | { kind: 'option'; cmd: Command; index: number };

/**
 * The global command palette (SYM-82). A top-anchored native `<dialog>` (via useModalDialog — so it
 * gets focus-trap, Escape→onCancel, scroll-lock, focus restore, and top-layer rendering that escapes
 * the .anim-page-in transform containing block, DESIGN.md §8 invariant #2) wrapping a WAI-ARIA
 * combobox + listbox. `commands` is built/memoized by Layout from the live ['projects']/['issues']
 * queries (zero extra network); `onSelect` runs the chosen command (navigate or dispatch an action)
 * and closes the palette.
 */
export function CommandPalette({
  onClose,
  commands,
  onSelect,
}: {
  onClose: () => void;
  commands: Command[];
  onSelect: (cmd: Command) => void;
}) {
  const { ref, handleCancel } = useModalDialog(onClose);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const showHeaders = query.trim() === '';

  // Visual order: in the default state, block by group (header + items); while searching, the already
  // globally-ranked `results` are kept flat. `flat` is what the arrow keys traverse.
  const { rows, flat } = useMemo(() => {
    const flat: Command[] = showHeaders
      ? GROUP_ORDER.flatMap((g) => results.filter((r) => r.group === g))
      : results;
    const rows: Row[] = [];
    let lastGroup: CommandGroup | null = null;
    flat.forEach((cmd, index) => {
      if (showHeaders && cmd.group !== lastGroup) {
        rows.push({ kind: 'header', key: `h-${cmd.group}`, label: GROUP_LABEL[cmd.group] });
        lastGroup = cmd.group;
      }
      rows.push({ kind: 'option', cmd, index });
    });
    return { rows, flat };
  }, [results, showHeaders]);

  // Reset the highlight to the top whenever the query changes; clamp if the list shrinks.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (active > flat.length - 1) setActive(flat.length === 0 ? 0 : flat.length - 1);
  }, [flat.length, active]);

  // Keep the highlighted option scrolled into view as the keyboard moves it.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const execute = (cmd: Command | undefined) => {
    if (cmd) onSelect(cmd);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (flat.length === 0) return; // Escape still flows to the <dialog> onCancel; nothing to navigate
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(flat.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(flat[active]);
    }
  };

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the ::backdrop reports the <dialog> as target
      }}
      aria-label="Command palette"
      className="anim-modal-in mx-auto mb-auto mt-[10vh] w-[calc(100vw-2rem)] max-w-xl overflow-hidden rounded-xl border border-border bg-panel p-0 text-fg shadow-[var(--elev-3)] backdrop:bg-black/60"
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden className="h-4 w-4 shrink-0 text-subtle" />
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={flat[active] ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search commands"
          placeholder="Search projects, issues, actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent py-3 text-sm text-fg outline-none placeholder:text-subtle"
        />
      </div>

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Commands"
        className="max-h-[min(60dvh,24rem)] overflow-y-auto p-1.5"
      >
        {rows.length === 0 ? (
          <li role="presentation" className="px-3 py-8 text-center text-sm text-muted">
            No matching commands
          </li>
        ) : (
          rows.map((row) =>
            row.kind === 'header' ? (
              <li
                key={row.key}
                role="presentation"
                aria-hidden
                className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle"
              >
                {row.label}
              </li>
            ) : (
              <CommandRow
                key={row.cmd.id}
                cmd={row.cmd}
                id={optionId(row.index)}
                selected={row.index === active}
                showGroup={!showHeaders}
                onMouseMove={() => setActive(row.index)}
                onClick={() => execute(row.cmd)}
              />
            ),
          )
        )}
      </ul>

      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[11px] text-subtle">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>navigate</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft className="h-3 w-3" />
          </Kbd>
          <span>open</span>
          <span aria-hidden className="px-1 text-border">·</span>
          <Kbd>Esc</Kbd>
          <span>close</span>
        </span>
      </div>
    </dialog>
  );
}

function CommandRow({
  cmd,
  id,
  selected,
  showGroup,
  onMouseMove,
  onClick,
}: {
  cmd: Command;
  id: string;
  selected: boolean;
  showGroup: boolean;
  onMouseMove: () => void;
  onClick: () => void;
}) {
  const Icon = ICONS[cmd.iconKey] ?? CircleDot;
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      onMouseMove={onMouseMove}
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
        selected ? 'bg-panel-2 text-fg' : 'text-muted',
      )}
    >
      <Icon aria-hidden className={cn('h-4 w-4 shrink-0', selected ? 'text-fg' : 'text-subtle')} />
      <span className="min-w-0 flex-1 truncate text-fg">{cmd.title}</span>
      {cmd.subtitle && <span className="hidden shrink-0 truncate text-xs text-subtle sm:block">{cmd.subtitle}</span>}
      {showGroup && <span className="shrink-0 text-[11px] text-subtle">{GROUP_LABEL[cmd.group]}</span>}
    </li>
  );
}
