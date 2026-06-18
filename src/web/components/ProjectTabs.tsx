import { NavLink } from 'react-router-dom';
import { Bot, Columns3 } from 'lucide-react';

export function ProjectTabs({ projectId }: { projectId: string }) {
  const tabs = [
    { to: `/projects/${projectId}`, label: 'Board', icon: Columns3, end: true },
    { to: `/projects/${projectId}/agent`, label: 'Agent', icon: Bot, end: false },
  ];

  return (
    <nav className="mb-4 flex items-center gap-1 border-b border-[#262b38]">
      {tabs.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `inline-flex items-center gap-1.5 border-b px-3 py-2 text-sm transition ${
              isActive
                ? 'border-indigo-400 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300'
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
