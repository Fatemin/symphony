import { NavLink } from 'react-router-dom';
import { Bot, Columns3, FileText, Network, ScanSearch, Sparkles } from 'lucide-react';

export function ProjectTabs({ projectId }: { projectId: string }) {
  const tabs = [
    { to: `/projects/${projectId}`, label: 'Board', icon: Columns3, end: true },
    { to: `/projects/${projectId}/agent`, label: 'Agent', icon: Bot, end: false },
    { to: `/projects/${projectId}/review`, label: 'Review', icon: ScanSearch, end: false },
    { to: `/projects/${projectId}/story-tree`, label: 'Story Tree', icon: Network, end: false },
    { to: `/projects/${projectId}/docs`, label: 'Docs', icon: FileText, end: false },
    { to: `/projects/${projectId}/skills`, label: 'Skills', icon: Sparkles, end: false },
  ];

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
