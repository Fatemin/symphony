import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Columns3,
  FolderKanban,
  Layers3,
  Menu,
  Moon,
  Music4,
  Search,
  Settings as SettingsIcon,
  Sun,
  X,
} from 'lucide-react';
import { api } from '../api';
import { STATUS_META } from '../lib/format';
import { buildCommands, type Command } from '../lib/commandPalette';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcutsHelp, Kbd } from './KeyboardShortcutsHelp';
import { SidebarUsage } from './SidebarUsage';
import { cn } from './ui';
import { useTheme } from '../theme';

/** True for inputs/textareas/selects/contenteditable — where a bare `?` should type, not open help. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const links = [
  { to: '/', label: 'All projects', icon: Layers3, end: true },
  { to: '/ops', label: 'Ops', icon: Activity, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];

const STORAGE_KEY = 'symphony.sidebar.expandedProjects';

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const { data: issues = [] } = useQuery({
    queryKey: ['issues'],
    queryFn: () => api.issues.list(),
    refetchInterval: 3000,
  });
  const counts = useMemo(() => {
    const map = new Map<string, { in_progress: number; review: number }>();
    for (const issue of issues) {
      if (issue.status !== 'in_progress' && issue.status !== 'review') continue;
      const entry = map.get(issue.project_id) ?? { in_progress: 0, review: 0 };
      entry[issue.status] += 1;
      map.set(issue.project_id, entry);
    }
    return map;
  }, [issues]);
  const currentProjectId = useMemo(() => location.pathname.match(/^\/projects\/([^/]+)/)?.[1], [location.pathname]);

  // SYM-82: the global command palette + keyboard-shortcuts overlay live here, in the always-mounted
  // shell, so ⌘K/? work from every route. The command set is built from the SAME ['projects']/['issues']
  // queries above (TanStack dedupes ⇒ zero extra network) and memoized so it only rebuilds on data change.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const modKey = useMemo(
    () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'),
    [],
  );
  const commands = useMemo(
    () => buildCommands(projects, issues, currentProjectId),
    [projects, issues, currentProjectId],
  );
  const kick = useMutation({
    mutationFn: api.ops.kick,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['snapshot'] });
      toast.success('Orchestrator kicked');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to kick orchestrator'),
  });

  // Run the chosen command: navigate, or dispatch a non-nav action. "New issue" routes to the current
  // project's board with router state so the Board opens its inline composer (else to All projects).
  const runCommand = useCallback(
    (cmd: Command) => {
      setPaletteOpen(false);
      if (cmd.to) {
        navigate(cmd.to);
        return;
      }
      switch (cmd.actionId) {
        case 'new-issue':
          if (currentProjectId) navigate(`/projects/${currentProjectId}`, { state: { compose: true } });
          else navigate('/');
          break;
        case 'toggle-theme':
          toggleTheme();
          break;
        case 'kick-orchestrator':
          kick.mutate();
          break;
        case 'show-shortcuts':
          setShortcutsOpen(true);
          break;
      }
    },
    [navigate, currentProjectId, toggleTheme, kick],
  );

  // ⌘K/Ctrl+K toggles the palette from anywhere (even inside an input); `?` opens the shortcuts overlay
  // only when not typing and no dialog is already open. Functional updates + a DOM guard keep deps empty
  // so the listener is registered once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === '?' && !isTypingTarget(e.target) && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded());
  // SYM-59: below `lg` the sidebar is an off-canvas drawer. Closes on navigation (route change) and on
  // Escape; a backdrop covers the page while it's open. On `lg+` it's a persistent static rail.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

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
    <div className="flex h-full bg-bg">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-panel px-3 py-2 text-sm font-medium text-fg shadow-[var(--elev-2)] focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      {/* Mobile drawer backdrop (lg: persistent rail, no backdrop). */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          aria-hidden
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside
        aria-label="Primary"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-bg-2 px-2 py-3 transition-transform duration-200 motion-reduce:transition-none lg:static lg:z-auto lg:translate-x-0 lg:!visible',
          navOpen ? 'translate-x-0 visible shadow-[var(--elev-3)]' : '-translate-x-full invisible',
        )}
      >
        <div className="mb-3 flex items-center gap-1">
          <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-fg hover:bg-hover">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-panel">
              <Music4 className="h-4 w-4 text-indigo-300" />
            </span>
            <span className="truncate text-sm font-semibold tracking-tight">Symphony</span>
          </Link>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* SYM-82: the discoverable command-palette trigger — also the mouse/touch entry point. */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          aria-keyshortcuts="Meta+K Control+K"
          className="mb-3 flex w-full items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-subtle transition hover:border-[var(--color-accent)]/50 hover:text-fg"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Search…</span>
          <span className="flex shrink-0 items-center gap-0.5">
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>

        <nav aria-label="Main" className="space-y-0.5">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={navClass}>
              <Icon className="h-4 w-4" />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-wide text-subtle">
            <span>Projects</span>
            <FolderKanban className="h-3.5 w-3.5" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {projects.map((project) => {
              const isOpen = expanded.has(project.id);
              const isCurrent = currentProjectId === project.id;
              const count = counts.get(project.id);
              return (
                <div key={project.id} className="mb-0.5">
                  <div className={`group flex items-center rounded-md ${isCurrent ? 'bg-panel' : 'hover:bg-hover'}`}>
                    <button
                      type="button"
                      aria-label={isOpen ? `Collapse ${project.name}` : `Expand ${project.name}`}
                      className="grid h-8 w-7 shrink-0 place-items-center rounded-md text-muted hover:text-fg"
                      onClick={() => toggleProject(project.id)}
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <NavLink
                      to={`/projects/${project.id}`}
                      end
                      className={({ isActive }) =>
                        `flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-sm transition ${
                          isActive || isCurrent ? 'text-fg' : 'text-muted hover:text-fg'
                        }`
                      }
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: project.color }} />
                      <span className="truncate">{project.name}</span>
                      {count && (count.in_progress > 0 || count.review > 0) && (
                        <span
                          className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
                          title={`${count.in_progress} in progress, ${count.review} in review`}
                        >
                          {count.in_progress > 0 && (
                            <span className="flex items-center gap-1">
                              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_META.in_progress.dot}`} />
                              {count.in_progress}
                            </span>
                          )}
                          {count.review > 0 && (
                            <span className="flex items-center gap-1">
                              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_META.review.dot}`} />
                              {count.review}
                            </span>
                          )}
                        </span>
                      )}
                    </NavLink>
                  </div>
                  {isOpen && (
                    <div className="ml-7 mt-0.5 space-y-0.5 border-l border-border pl-2">
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

        <div className="mt-3 border-t border-border px-2 pt-3">
          <SidebarUsage />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only top bar: the menu trigger for the off-canvas sidebar (hidden on lg+). */}
        <div className="flex items-center gap-2 border-b border-border bg-bg-2 px-3 py-2 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            <Menu className="h-4 w-4" />
          </button>
          <Link to="/" className="flex min-w-0 items-center gap-2 text-fg">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-panel">
              <Music4 className="h-4 w-4 text-indigo-300" />
            </span>
            <span className="truncate text-sm font-semibold tracking-tight">Symphony</span>
          </Link>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            aria-keyshortcuts="Meta+K Control+K"
            className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-fg"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          {/* SYM-31: keyed by pathname so the entrance animation re-runs on each navigation. The
              wrapper stays inside <main> (the scroll container must not remount) and carries h-full so
              full-height pages (flex h-full flex-col) still get a definite-height parent. */}
          <div key={location.pathname} className="anim-page-in h-full">
            <Outlet />
          </div>
        </main>
      </div>

      {/* SYM-82: global overlays — mounted once here so ⌘K/? reach them from any route. Native
          <dialog>s render in the top layer regardless of their position in this tree. */}
      {paletteOpen && (
        <CommandPalette commands={commands} onSelect={runCommand} onClose={() => setPaletteOpen(false)} />
      )}
      {shortcutsOpen && <KeyboardShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
    isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-hover hover:text-fg'
  }`;
}

function subNavClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition ${
    isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-hover hover:text-fg'
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
