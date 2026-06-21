import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue, Project } from '../src/shared/types';

// SYM-82: buildCommands / filterCommands are PURE web helpers (type-only shared imports + the pure
// projectTabs list, no React runtime), so they import and assert straight from a node:test — fully
// offline, mirroring tests/boardGroups.test.ts.
const { buildCommands, filterCommands, MAX_RESULTS } = await import('../src/web/lib/commandPalette');

const PROJECT: Project = {
  id: 'p1',
  key: 'WEB',
  name: 'Web App',
  description: null,
  color: '#6366f1',
  repo_path: '/tmp/web',
  default_branch: 'main',
  context: null,
  model: null,
  agent: null,
  preview_command: null,
  config: null,
  created_at: '2026-01-01T00:00:00.000Z',
};
const mkProject = (over: Partial<Project> & Pick<Project, 'id'>): Project => ({ ...PROJECT, ...over });

const ISSUE: Issue = {
  id: 'i1',
  project_id: 'p1',
  parent_id: null,
  key: 'WEB-1',
  type: 'feature',
  title: 'Hello world',
  description: null,
  acceptance_criteria: null,
  labels: [],
  priority: 0,
  status: 'todo',
  mode: 'manual',
  thinking_effort: null,
  enable_workflow_tool: null,
  require_review: true,
  base_branch: null,
  branch_name: null,
  worktree_path: null,
  round: 1,
  merge_conflict: null,
  source: 'manual',
  source_run_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const mkIssue = (over: Partial<Issue> & Pick<Issue, 'id'>): Issue => ({ ...ISSUE, ...over });

const PROJECT_TAB_COUNT = 6; // board + 5 section tabs (kept in sync via lib/projectTabs.ts)
const ACTION_COUNT = 4; // new issue, toggle theme, kick orchestrator, keyboard shortcuts
const NAV_COUNT = 3; // all projects, ops, settings

test('buildCommands covers actions, nav, every project×tab, and every issue', () => {
  const projects = [mkProject({ id: 'p1', key: 'WEB', name: 'Web App' }), mkProject({ id: 'p2', key: 'API', name: 'API Service' })];
  const issues = [mkIssue({ id: 'i1', key: 'WEB-1' }), mkIssue({ id: 'i2', key: 'API-1', project_id: 'p2' })];
  const cmds = buildCommands(projects, issues);

  const byGroup = (g: string) => cmds.filter((c) => c.group === g);
  assert.equal(byGroup('actions').length, ACTION_COUNT);
  assert.equal(byGroup('navigation').length, NAV_COUNT);
  assert.equal(byGroup('projects').length, projects.length * PROJECT_TAB_COUNT);
  assert.equal(byGroup('issues').length, issues.length);

  // Every command targets either a route (`to`) or a dispatchable action — never both, never neither.
  for (const c of cmds) assert.ok((c.to == null) !== (c.actionId == null), `${c.id} must have exactly one of to/actionId`);

  // A project tab command points at the real route; an issue command at /issues/:id with the project as subtitle.
  const board = cmds.find((c) => c.id === 'project:p2:board');
  assert.equal(board?.to, '/projects/p2');
  assert.equal(board?.title, 'API Service · Board');
  const issue = cmds.find((c) => c.id === 'issue:i2');
  assert.equal(issue?.to, '/issues/i2');
  assert.equal(issue?.subtitle, 'API Service');
  assert.match(issue?.keywords ?? '', /API-1/);
});

test('buildCommands makes "New issue" context-aware on the current project', () => {
  const projects = [mkProject({ id: 'p1', name: 'Web App' })];
  const withCtx = buildCommands(projects, [], 'p1').find((c) => c.actionId === 'new-issue');
  const noCtx = buildCommands(projects, [], undefined).find((c) => c.actionId === 'new-issue');
  assert.equal(withCtx?.title, 'New issue in Web App');
  assert.equal(noCtx?.title, 'New issue');
});

test('filterCommands empty query returns the default set (actions + nav only, no issues)', () => {
  const cmds = buildCommands([mkProject({ id: 'p1' })], [mkIssue({ id: 'i1' })]);
  const def = filterCommands(cmds, '');
  assert.equal(def.length, ACTION_COUNT + NAV_COUNT);
  assert.ok(def.every((c) => c.group === 'actions' || c.group === 'navigation'));
  // Whitespace-only is treated as empty too.
  assert.equal(filterCommands(cmds, '   ').length, ACTION_COUNT + NAV_COUNT);
});

test('filterCommands ranks a title prefix/exact match above a weaker word-boundary match', () => {
  const cmds = buildCommands([mkProject({ id: 'p1' })], [mkIssue({ id: 'i1', key: 'WEB-9', title: 'Settings page redesign' })]);
  // 'sett' prefixes the "Settings" nav title (tier: prefix) and only hits a word-boundary token in the issue.
  const ranked = filterCommands(cmds, 'sett');
  assert.equal(ranked[0]?.id, 'nav:settings');
  // 'ops' is an EXACT title match for the Ops nav command → ranked first.
  assert.equal(filterCommands(cmds, 'ops')[0]?.id, 'nav:ops');
});

test('filterCommands is case-insensitive', () => {
  const cmds = buildCommands([mkProject({ id: 'p1' })], []);
  assert.equal(filterCommands(cmds, 'SETTINGS')[0]?.id, 'nav:settings');
  assert.equal(filterCommands(cmds, 'settings')[0]?.id, 'nav:settings');
});

test('filterCommands caps the ranked result set at MAX_RESULTS', () => {
  const issues = Array.from({ length: 100 }, (_, n) => mkIssue({ id: `i${n}`, key: `WEB-${n}`, title: `alpha item ${n}` }));
  const cmds = buildCommands([mkProject({ id: 'p1', name: 'Beta' })], issues);
  const matches = filterCommands(cmds, 'alpha'); // matches all 100 issue titles, nothing else
  assert.equal(matches.length, MAX_RESULTS);
  assert.ok(matches.every((c) => c.group === 'issues'));
});

test('filterCommands returns [] when nothing matches', () => {
  const cmds = buildCommands([mkProject({ id: 'p1', name: 'Web App' })], [mkIssue({ id: 'i1', title: 'Hello world' })]);
  assert.deepEqual(filterCommands(cmds, 'qqqq'), []);
});
