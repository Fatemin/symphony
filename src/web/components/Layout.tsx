import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Columns3,
  FolderKanban,
  Layers3,
  Music4,
  Settings as SettingsIcon,
} from 'lucide-react';
import { api } from '../api';

const links = [
  { to: '/', label: 'All projects', icon: Layers3, end: true },
  { to: '/ops', label: 'Ops', icon: Activity, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];

const STORAGE_KEY = 'symphony.sidebar.expandedProjects';

export function Layout() {
  const location = useLocation();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const currentProjectId = useMemo(() => location.pathname.match(/^\/projects\/([^/]+)/)?.[1], [location.pathname]);
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded());

  useEffect(() => {
    if (!currentProjectId) return;
    setExpanded((prev) => (prev.has(currentProjectId) ? prev : new Set([...prev, currentProjectId])));
  }, [currentProjectId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expanded]));
    } catch {
      /* localStorage may be unavailable in hardened browser contexts */
    }
  }, [expanded]);

  const toggleProject = (projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <div className="flex h-full bg-[#0b0d12]">
      <aside className="flex w-64 shrink-0 flex-col border-r border-[#24262d] bg-[#0c0d10] px-2 py-3">
        <Link to="/" className="mb-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 hover:bg-[#17191f]">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[#17191f]">
            <Music4 className="h-4 w-4 text-indigo-300" />
          </span>
          <span className="text-sm font-semibold tracking-tight">Symphony</span>
        </Link>

        <nav className="space-y-0.5">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={navClass}>
              <Icon className="h-4 w-4" />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-wide text-slate-600">
            <span>Projects</span>
            <FolderKanban className="h-3.5 w-3.5" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {projects.map((project) => {
              const isOpen = expanded.has(project.id);
              const isCurrent = currentProjectId === project.id;
              return (
                <div key={project.id} className="mb-0.5">
                  <div className={`group flex items-center rounded-md ${isCurrent ? 'bg-[#17191f]' : 'hover:bg-[#13151a]'}`}>
                    <button
                      type="button"
                      aria-label={isOpen ? `Collapse ${project.name}` : `Expand ${project.name}`}
                      className="grid h-8 w-7 shrink-0 place-items-center rounded-md text-slate-500 hover:text-slate-200"
                      onClick={() => toggleProject(project.id)}
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <NavLink
                      to={`/projects/${project.id}`}
                      end
                      className={({ isActive }) =>
                        `flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-sm transition ${
                          isActive || isCurrent ? 'text-slate-100' : 'text-slate-400 hover:text-slate-200'
                        }`
                      }
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: project.color }} />
                      <span className="truncate">{project.name}</span>
                    </NavLink>
                  </div>
                  {isOpen && (
                    <div className="ml-7 mt-0.5 space-y-0.5 border-l border-[#24262d] pl-2">
                      <NavLink to={`/projects/${project.id}`} end className={subNavClass}>
                        <Columns3 className="h-3.5 w-3.5" />
                        <span>Board</span>
                      </NavLink>
                      <NavLink to={`/projects/${project.id}/agent`} className={subNavClass}>
                        <Bot className="h-3.5 w-3.5" />
                        <span>Agent</span>
                      </NavLink>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 border-t border-[#24262d] px-2 pt-3 text-[11px] leading-relaxed text-slate-600">
          Claude Code agents · isolated worktrees
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
    isActive ? 'bg-[#17191f] text-slate-100' : 'text-slate-400 hover:bg-[#13151a] hover:text-slate-200'
  }`;
}

function subNavClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition ${
    isActive ? 'bg-[#1b1d24] text-slate-100' : 'text-slate-500 hover:bg-[#13151a] hover:text-slate-300'
  }`;
}

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
