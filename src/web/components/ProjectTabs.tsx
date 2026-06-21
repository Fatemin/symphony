import { NavLink } from 'react-router-dom';
import { Bot, Columns3, FileText, Network, ScanSearch, Sparkles, type LucideIcon } from 'lucide-react';
import { PROJECT_TABS, projectTabTo, type ProjectTabKey } from '../lib/projectTabs';

// SYM-82: the tab definitions (label/path/end) moved to the pure lib/projectTabs.ts so the command
// palette navigates to the exact same set. Icons stay here in the view layer (keyed by tab).
const TAB_ICONS: Record<ProjectTabKey, LucideIcon> = {
  board: Columns3,
  agent: Bot,
  review: ScanSearch,
  'story-tree': Network,
  docs: FileText,
  skills: Sparkles,
};

export function ProjectTabs({ projectId }: { projectId: string }) {
  const tabs = PROJECT_TABS.map((tab) => ({
    to: projectTabTo(projectId, tab),
    label: tab.label,
    icon: TAB_ICONS[tab.key],
    end: tab.end,
  }));

  return (
    // SYM-59: scrolls horizontally on narrow viewports instead of wrapping/overflowing — the tabs
    // stay a single row with a thin scrollbar; -mb-px overlaps the row's own bottom border.
    <nav
      aria-label="Project sections"
      className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b -mb-px px-3 py-2 text-sm transition ${
              isActive
                ? 'border-[var(--color-accent)] text-fg' // SYM-73: accent token re-themes for light mode
                : 'border-transparent text-muted hover:text-fg'
            }`
          }
        >
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
