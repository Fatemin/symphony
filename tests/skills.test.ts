import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { parseGithubSkillUrl, stripFrontMatter } = await import('../src/server/core/githubSkill');
const { buildSkillMarkdown, skillSlug, materializeSkills } = await import('../src/server/workspace/skills');
const { createProject } = await import('../src/server/repo/projects');
const { createProjectSkill, listProjectSkills } = await import('../src/server/repo/projectSkills');
const { projectRoutes } = await import('../src/server/http/routes/projects');

test.after(() => env.cleanup());

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ── parseGithubSkillUrl (pure, offline) ──────────────────────────────────────

test('parseGithubSkillUrl resolves common GitHub link shapes to a raw SKILL.md', () => {
  assert.equal(
    parseGithubSkillUrl('https://github.com/o/r/blob/main/skills/foo/SKILL.md'),
    'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md',
  );
  // A tree/folder link gets SKILL.md appended.
  assert.equal(
    parseGithubSkillUrl('https://github.com/o/r/tree/main/skills/foo'),
    'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md',
  );
  // A raw URL is honored as-is.
  assert.equal(
    parseGithubSkillUrl('https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md'),
    'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md',
  );
  // A raw directory URL gets SKILL.md appended.
  assert.equal(
    parseGithubSkillUrl('https://raw.githubusercontent.com/o/r/main/skills/foo'),
    'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md',
  );
});

test('parseGithubSkillUrl rejects unsupported URLs', () => {
  assert.throws(() => parseGithubSkillUrl('not a url'));
  assert.throws(() => parseGithubSkillUrl('https://example.com/skills/foo'));
  assert.throws(() => parseGithubSkillUrl('https://github.com/o/r')); // no blob/tree/ref
});

// ── front-matter helpers (pure, offline) ─────────────────────────────────────

test('stripFrontMatter removes a leading YAML block and keeps the body', () => {
  const raw = '---\nname: foo\ndescription: bar\n---\n\nBody line one.\n';
  assert.equal(stripFrontMatter(raw).trim(), 'Body line one.');
  assert.equal(stripFrontMatter('No front matter here.').trim(), 'No front matter here.');
});

test('buildSkillMarkdown synthesizes valid front matter and strips any existing one', () => {
  const md = buildSkillMarkdown({
    name: 'My Cool Skill',
    description: 'Use me for X',
    content: '---\nname: stale\ndescription: stale\n---\n\nDo the thing.',
  });
  assert.ok(md.startsWith('---\n'), 'starts with a front-matter fence');
  assert.match(md, /name: my-cool-skill/, 'name is slugified from the DB row');
  assert.match(md, /description: Use me for X/);
  assert.match(md, /Do the thing\./);
  // The stale front matter from the stored content must not survive.
  assert.doesNotMatch(md, /stale/);
  assert.equal(skillSlug('My Cool Skill'), 'my-cool-skill');
});

// ── materializeSkills (filesystem, offline) ──────────────────────────────────

function gitInit(dir: string): void {
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Symphony Test');
}

test('materializeSkills writes enabled skills and excludes them from git', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-skills-'));
  gitInit(worktree);
  try {
    await materializeSkills(worktree, [
      mkSkill({ name: 'Alpha Skill', description: 'first', content: 'alpha body' }),
      mkSkill({ name: 'Beta', enabled: false }), // disabled → skipped
    ]);

    const alpha = path.join(worktree, '.claude', 'skills', 'alpha-skill', 'SKILL.md');
    assert.ok(fs.existsSync(alpha), 'enabled skill SKILL.md is written');
    assert.match(fs.readFileSync(alpha, 'utf8'), /name: alpha-skill/);
    assert.ok(!fs.existsSync(path.join(worktree, '.claude', 'skills', 'beta')), 'disabled skill is not written');

    // .claude/skills is excluded from git so the agent can't commit it.
    const exclude = fs.readFileSync(path.join(worktree, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /\.claude\/skills\//);

    // Re-running is idempotent: the exclude entry is not duplicated.
    await materializeSkills(worktree, [mkSkill({ name: 'Alpha Skill' })]);
    const excludeAgain = fs.readFileSync(path.join(worktree, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(excludeAgain.match(/\.claude\/skills\//g)?.length, 1, 'exclude entry is not duplicated');
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('materializeSkills cleans up its own skills when none remain, but leaves a repo-committed dir', async () => {
  // Symphony-owned dir: materialize once, then re-run with nothing → the dir is removed.
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-skills-'));
  gitInit(owned);
  // A repo with its OWN committed .claude/skills (no Symphony exclude marker) must be left alone.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-skills-'));
  gitInit(repo);
  const repoSkill = path.join(repo, '.claude', 'skills', 'mine', 'SKILL.md');
  fs.mkdirSync(path.dirname(repoSkill), { recursive: true });
  fs.writeFileSync(repoSkill, 'committed');
  try {
    await materializeSkills(owned, [mkSkill({ name: 'Gone Soon' })]);
    assert.ok(fs.existsSync(path.join(owned, '.claude', 'skills', 'gone-soon')));
    await materializeSkills(owned, []); // all skills removed
    assert.ok(!fs.existsSync(path.join(owned, '.claude', 'skills')), 'Symphony-owned skills dir is cleaned up');

    await materializeSkills(repo, []); // never materialized here → must not touch the repo's files
    assert.ok(fs.existsSync(repoSkill), "a repo's own committed skills are left untouched");
  } finally {
    fs.rmSync(owned, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('materializeSkills rejects path traversal via an extra file (safety invariant)', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-skills-'));
  gitInit(worktree);
  try {
    await assert.rejects(
      materializeSkills(worktree, [
        mkSkill({ name: 'Evil', files: [{ path: '../../escape.txt', content: 'pwned' }] }),
      ]),
      /escapes its directory/,
    );
    assert.ok(!fs.existsSync(path.join(worktree, '..', 'escape.txt')));
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

// ── HTTP CRUD via the Hono router (manual path, offline) ─────────────────────

test('skills CRUD round-trips through the project routes without any network', async () => {
  const project = createProject({ name: 'Skill Routes', key: 'SR', repo_path: env.repoPath });

  // create
  let res = await projectRoutes.request(`/${project.id}/skills`, json({ name: 'lint-rules', description: 'how to lint', content: 'Run npm run lint.' }));
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: string; source: string; enabled: boolean };
  assert.equal(created.source, 'manual');
  assert.equal(created.enabled, true);

  // duplicate name → 409
  res = await projectRoutes.request(`/${project.id}/skills`, json({ name: 'lint-rules' }));
  assert.equal(res.status, 409);

  // missing name → 400
  res = await projectRoutes.request(`/${project.id}/skills`, json({ description: 'x' }));
  assert.equal(res.status, 400);

  // import with no url → 400 (does not hit the network)
  res = await projectRoutes.request(`/${project.id}/skills/import`, json({}));
  assert.equal(res.status, 400);

  // list
  res = await projectRoutes.request(`/${project.id}/skills`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as unknown[]).length, 1);

  // patch (disable)
  res = await projectRoutes.request(`/${project.id}/skills/${created.id}`, json({ enabled: false }, 'PATCH'));
  assert.equal(res.status, 200);
  assert.equal(listProjectSkills(project.id)[0]!.enabled, false);

  // delete
  res = await projectRoutes.request(`/${project.id}/skills/${created.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(listProjectSkills(project.id).length, 0);
});

interface SkillSeed {
  name: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  files?: { path: string; content: string }[];
}

/** Build a fully-shaped ProjectSkill for the materializer tests (no DB needed). */
function mkSkill(seed: SkillSeed) {
  return {
    id: seed.name,
    project_id: 'p',
    name: seed.name,
    description: seed.description ?? null,
    content: seed.content ?? '',
    files: seed.files ?? [],
    source: 'manual' as const,
    source_url: null,
    enabled: seed.enabled ?? true,
    created_at: '',
    updated_at: '',
  };
}
