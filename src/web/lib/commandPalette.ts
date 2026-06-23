import type { Issue, Project } from '../../shared/types';
import { PROJECT_TABS, projectTabTo } from './projectTabs';

// SYM-82: the command palette's pure data layer — building the flat command set and the fuzzy filter
// that ranks it. Like lib/boardGroups.ts it imports only types from shared + the pure projectTabs
// list, so it carries NO React runtime and is unit-testable straight from a node:test
// (tests/commandPalette.test.ts). The CommandPalette component owns rendering, keyboard nav, and
// dispatch; this module owns "what commands exist" and "how a query ranks them" only.

export type CommandGroup = 'actions' | 'navigation' | 'projects' | 'issues';

/** A non-navigation action; the component dispatches it against live callbacks (theme/kick/…). */
export type CommandActionId = 'new-issue' | 'toggle-theme' | 'kick-orchestrator' | 'show-shortcuts';

export interface Command {
  /** Stable unique id — React key + the listbox option's `id` for aria-activedescendant. */
  id: string;
  title: string;
  subtitle?: string;
  /** Extra haystack text (project key/name, issue status/type) folded into matching, never shown. */
  keywords?: string;
  group: CommandGroup;
  /** Resolved to a lucide icon in CommandPalette.tsx, so this module imports nothing from lucide. */
  iconKey: string;
  /** Navigation target (react-router path). Exactly one of `to` / `actionId` is set. */
  to?: string;
  /** Non-navigation action the component dispatches. Exactly one of `to` / `actionId` is set. */
  actionId?: CommandActionId;
}

/** Cap on rendered result rows. Filtering hundreds of issues per keystroke is sub-ms, but an
 *  unbounded listbox would be slow to paint and impossible to scan — so the ranked set is sliced. */
export const MAX_RESULTS = 50;

/** Order/weight used only to break ties between commands that scored the same structural tier. */
const GROUP_BONUS: Record<CommandGroup, number> = { actions: 3, navigation: 2, projects: 1, issues: 0 };

/**
 * Build the full flat command set from the live data Layout already holds. Pure (no callbacks): each
 * non-nav action is represented by a stable `actionId` the component dispatches, so the result depends
 * only on (projects, issues, currentProjectId) and memoizes cleanly.
 *
 * The set: primary actions (context-aware New issue, Toggle theme, Kick orchestrator, Keyboard
 * shortcuts) → static nav (All projects / Ops / Settings) → one command per project × section tab
 * (`Name · Tab`, from the shared PROJECT_TABS list) → one per issue (`KEY · title`, project as
 * subtitle). Insertion order doubles as the within-tier ranking fallback (see GROUP_BONUS).
 */
export function buildCommands(
  projects: Project[],
  issues: Issue[],
  currentProjectId?: string,
): Command[] {
  const commands: Command[] = [];
  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  const currentProject = currentProjectId ? projectById.get(currentProjectId) : undefined;

  // ── Actions (always available; the empty-query default surfaces these first) ──
  commands.push({
    id: 'action:new-issue',
    title: currentProject ? `New issue in ${currentProject.name}` : 'New issue',
    subtitle: currentProject ? undefined : 'Open a project board to add one',
    keywords: 'create add new issue task story',
    group: 'actions',
    iconKey: 'new-issue',
    actionId: 'new-issue',
  });
  commands.push({
    id: 'action:toggle-theme',
    title: 'Toggle theme',
    subtitle: 'Switch light / dark',
    keywords: 'theme dark light mode appearance color',
    group: 'actions',
    iconKey: 'theme',
    actionId: 'toggle-theme',
  });
  commands.push({
    id: 'action:kick',
    title: 'Kick orchestrator',
    subtitle: 'Dispatch ready work now',
    keywords: 'kick orchestrator run dispatch start',
    group: 'actions',
    iconKey: 'kick',
    actionId: 'kick-orchestrator',
  });
  commands.push({
    id: 'action:shortcuts',
    title: 'Keyboard shortcuts',
    subtitle: 'Show all shortcuts',
    keywords: 'keyboard shortcuts help keys hotkeys cheatsheet',
    group: 'actions',
    iconKey: 'shortcuts',
    actionId: 'show-shortcuts',
  });

  // ── Static navigation (mirrors the sidebar's primary links) ──
  commands.push({ id: 'nav:projects', title: 'All projects', keywords: 'home projects overview dashboard', group: 'navigation', iconKey: 'projects', to: '/' });
  commands.push({ id: 'nav:ops', title: 'Ops', subtitle: 'Orchestrator activity', keywords: 'ops orchestrator runs activity status snapshot', group: 'navigation', iconKey: 'ops', to: '/ops' });
  commands.push({ id: 'nav:settings', title: 'Settings', keywords: 'settings config engine preferences', group: 'navigation', iconKey: 'settings', to: '/settings' });

  // ── Per-project: Board + each section tab (Name · Tab), kept in sync via PROJECT_TABS ──
  for (const project of projects) {
    for (const tab of PROJECT_TABS) {
      commands.push({
        id: `project:${project.id}:${tab.key}`,
        title: `${project.name} · ${tab.label}`,
        keywords: `${project.key} ${project.name} ${tab.label} project`,
        group: 'projects',
        iconKey: `tab:${tab.key}`,
        to: projectTabTo(project.id, tab),
      });
    }
  }

  // ── Issues (KEY · title → /issues/:id; project name as the subtitle + a keyword) ──
  for (const issue of issues) {
    const project = projectById.get(issue.project_id);
    commands.push({
      id: `issue:${issue.id}`,
      title: `${issue.key} · ${issue.title}`,
      subtitle: project?.name,
      keywords: `${issue.key} ${issue.title} ${issue.status} ${issue.type}${project ? ` ${project.name}` : ''}`,
      group: 'issues',
      iconKey: 'issue',
      to: `/issues/${issue.id}`,
    });
  }

  return commands;
}

/** Does every char of `q` appear in `text` in order? Both must already be lowercased. */
function isSubsequence(text: string, q: string): boolean {
  if (!q) return true;
  let i = 0;
  for (let c = 0; c < text.length && i < q.length; c++) {
    if (text[c] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Structural match tier of `q` against one `text` (both lowercased), highest first:
 * exact > prefix > word-boundary prefix > substring > subsequence > none(-1). The tiers are spaced
 * so they dominate the group/length tie-breaks in `score`.
 */
function textTier(text: string, q: string): number {
  if (text === q) return 100;
  if (text.startsWith(q)) return 80;
  for (const word of text.split(/[^a-z0-9]+/)) {
    if (word && word.startsWith(q)) return 60;
  }
  if (text.includes(q)) return 40;
  if (isSubsequence(text, q)) return 20;
  return -1;
}

/**
 * Rank a command for `q`: the title (the primary visible label) drives the structural tier; if it
 * doesn't match, fall back to a weaker substring/subsequence match anywhere in the haystack
 * (title + subtitle + keywords) so a keyword-only hit (e.g. "dark" → Toggle theme) still ranks, below
 * any title match. Ties break by group then by shorter title (a more specific match). Returns null
 * when nothing matches.
 */
function score(cmd: Command, q: string): number | null {
  const title = cmd.title.toLowerCase();
  let tier = textTier(title, q);
  if (tier < 0) {
    const hay = [cmd.title, cmd.subtitle, cmd.keywords].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(q)) tier = 30;
    else if (isSubsequence(hay, q)) tier = 15;
    else return null;
  }
  return tier * 10_000 + GROUP_BONUS[cmd.group] * 1_000 - Math.min(title.length, 999);
}

/**
 * Filter + rank `commands` for `query`, capped at `cap` rows. An empty query returns the default set —
 * the primary actions and static nav (not every issue) — so the palette opens to something useful.
 * Case-insensitive throughout; no match → []. Array#sort is stable, so equal scores keep build order.
 */
export function filterCommands(commands: Command[], query: string, cap = MAX_RESULTS): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return commands.filter((c) => c.group === 'actions' || c.group === 'navigation').slice(0, cap);
  }
  const scored: { cmd: Command; score: number }[] = [];
  for (const cmd of commands) {
    const s = score(cmd, q);
    if (s !== null) scored.push({ cmd, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap).map((x) => x.cmd);
}
