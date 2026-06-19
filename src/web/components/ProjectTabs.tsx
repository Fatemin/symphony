import { NavLink } from 'react-router-dom';
import { Bot, Columns3, FileText, Network, Sparkles } from 'lucide-react';

export function ProjectTabs({ projectId }: { projectId: string }) {
  const tabs = [
    { to: `/projects/${projectId}`, label: 'Board', icon: Columns3, end: true },
    { to: `/projects/${projectId}/agent`, label: 'Agent', icon: Bot, end: false },
    { to: `/projects/${projectId}/story-tree`, label: 'Story Tree', icon: Network, end: false },
    { to: `/projects/${projectId}/docs`, label: 'Docs', icon: FileText, end: false },
    { to: `/projects/${projectId}/skills`, label: 'Skills', icon: Sparkles, end: false },
  ];

  return (
    <nav className="mb-4 flex items-center gap-1 border-b border-border">
      {tabs.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `inline-flex items-center gap-1.5 border-b px-3 py-2 text-sm transition ${
              isActive
                ? 'border-indigo-400 text-fg'
                : 'border-transparent text-muted hover:text-fg'
            }`
          }
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
