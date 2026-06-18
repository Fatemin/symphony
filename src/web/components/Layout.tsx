import { NavLink, Outlet } from 'react-router-dom';
import { Activity, FolderKanban, Settings as SettingsIcon, Music4, Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme';

const links = [
  { to: '/', label: 'Projects', icon: FolderKanban, end: true },
  { to: '/ops', label: 'Ops', icon: Activity, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];

export function Layout() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-bg-2 p-3">
        <div className="mb-6 flex items-center gap-2 px-2 pt-2">
          <Music4 className="h-5 w-5 text-indigo-400" />
          <span className="text-sm font-semibold tracking-tight">Symphony</span>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
        <nav className="flex flex-col gap-1">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition ${
                  isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-[11px] leading-relaxed text-subtle">
          Claude Code agents · isolated worktrees · one human gate
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
