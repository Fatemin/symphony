import { NavLink, Outlet } from 'react-router-dom';
import { Activity, FolderKanban, Settings as SettingsIcon, Music4 } from 'lucide-react';

const links = [
  { to: '/', label: 'Projects', icon: FolderKanban, end: true },
  { to: '/ops', label: 'Ops', icon: Activity, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];

export function Layout() {
  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-[#262b38] bg-[#0f1218] p-3">
        <div className="mb-6 flex items-center gap-2 px-2 pt-2">
          <Music4 className="h-5 w-5 text-indigo-400" />
          <span className="text-sm font-semibold tracking-tight">Symphony</span>
        </div>
        <nav className="flex flex-col gap-1">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition ${
                  isActive ? 'bg-[#1b1f2a] text-white' : 'text-slate-400 hover:bg-[#171b24] hover:text-slate-200'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-[11px] leading-relaxed text-slate-600">
          Claude Code agents · isolated worktrees · one human gate
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
