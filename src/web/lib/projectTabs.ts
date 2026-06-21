// SYM-82: the single source of truth for a project's section tabs. Both ProjectTabs.tsx (the visible
// tab strip) and the command palette (lib/commandPalette.ts) read this list, so project-scoped
// navigation can never drift from the tabs the UI actually shows. Pure data — no React, no
// lucide-react import — so it stays importable from a node:test exactly like lib/boardGroups.ts; the
// `iconKey` is resolved to a lucide icon in the React layer (ProjectTabs / CommandPalette), not here.

export type ProjectTabKey = 'board' | 'agent' | 'review' | 'story-tree' | 'docs' | 'skills';

export interface ProjectTabDef {
  key: ProjectTabKey;
  label: string;
  /** Suffix appended to `/projects/:id`; '' is the Board index route. */
  path: string;
  /** NavLink `end` — only the Board (the index) needs an exact match so it isn't active on sub-tabs. */
  end: boolean;
}

export const PROJECT_TABS: ProjectTabDef[] = [
  { key: 'board', label: 'Board', path: '', end: true },
  { key: 'agent', label: 'Agent', path: '/agent', end: false },
  { key: 'review', label: 'Review', path: '/review', end: false },
  { key: 'story-tree', label: 'Story Tree', path: '/story-tree', end: false },
  { key: 'docs', label: 'Docs', path: '/docs', end: false },
  { key: 'skills', label: 'Skills', path: '/skills', end: false },
];

/** Absolute router path for a project's tab. */
export function projectTabTo(projectId: string, tab: ProjectTabDef): string {
  return `/projects/${projectId}${tab.path}`;
}
