import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { parseGithubSkillUrl, parseGithubSkillRef, fetchGithubSkill, stripFrontMatter } = await import(
  '../src/server/core/githubSkill'
);
const { parseMarketplaceImport } = await import('../src/server/core/marketplaceSkill');
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

/** Run `fn` with `globalThis.fetch` replaced by `stub`, always restoring the real fetch after. */
async function withFetch(stub: typeof globalThis.fetch, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

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

// ── parseGithubSkillRef: directory-vs-file trigger (pure, offline) ────────────

test('parseGithubSkillRef flags folder links as directories and *.md links as single files', () => {
  // A /tree/ folder link → directory: list siblings under skills/foo.
  const tree = parseGithubSkillRef('https://github.com/o/r/tree/main/skills/foo');
  assert.equal(tree.isDirectory, true);
  assert.deepEqual(
    { owner: tree.owner, repo: tree.repo, ref: tree.ref, dir: tree.dir },
    { owner: 'o', repo: 'r', ref: 'main', dir: 'skills/foo' },
  );
  assert.equal(tree.rawSkillUrl, 'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md');

  // An explicit blob/.../SKILL.md → NOT a directory; dir is the parent that holds any siblings.
  const blob = parseGithubSkillRef('https://github.com/o/r/blob/main/skills/foo/SKILL.md');
  assert.equal(blob.isDirectory, false);
  assert.equal(blob.dir, 'skills/foo');

  // A raw directory URL is also a directory reference.
  assert.equal(parseGithubSkillRef('https://raw.githubusercontent.com/o/r/main/skills/foo').isDirectory, true);
});

// ── fetchGithubSkill: sibling-file import (offline via a stubbed fetch, SYM-50) ─

test('fetchGithubSkill on a /tree/ folder imports SKILL.md plus nested sibling files', async () => {
  const SKILL_MD = '---\nname: foo\ndescription: A multi-file skill\n---\n\nUse the references.';
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md') {
      return new Response(SKILL_MD, { status: 200 });
    }
    if (url === 'https://api.github.com/repos/o/r/contents/skills/foo?ref=main') {
      return new Response(
        JSON.stringify([
          // The top-level SKILL.md is listed too — it must NOT be duplicated into files.
          { type: 'file', name: 'SKILL.md', path: 'skills/foo/SKILL.md', size: SKILL_MD.length, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md' },
          { type: 'file', name: 'reference.md', path: 'skills/foo/reference.md', size: 17, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/foo/reference.md' },
          { type: 'dir', name: 'scripts', path: 'skills/foo/scripts', size: 0, download_url: null },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/repos/o/r/contents/skills/foo/scripts?ref=main') {
      return new Response(
        JSON.stringify([
          { type: 'file', name: 'build.sh', path: 'skills/foo/scripts/build.sh', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/foo/scripts/build.sh' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/foo/reference.md') {
      return new Response('reference content', { status: 200 });
    }
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/foo/scripts/build.sh') {
      return new Response('echo build', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const fetched = await fetchGithubSkill('https://github.com/o/r/tree/main/skills/foo');
    assert.equal(fetched.name, 'foo');
    assert.equal(fetched.content, 'Use the references.'); // SKILL.md body, front matter stripped
    assert.ok(fetched.files, 'sibling files are populated for a folder import');
    const byPath = Object.fromEntries(fetched.files!.map((f) => [f.path, f.content]));
    assert.deepEqual(Object.keys(byPath).sort(), ['reference.md', 'scripts/build.sh']);
    assert.equal(byPath['reference.md'], 'reference content');
    assert.equal(byPath['scripts/build.sh'], 'echo build'); // nested path preserved
    // SKILL.md is the `content`, never re-imported as a sibling file.
    assert.ok(!fetched.files!.some((f) => /skill\.md/i.test(f.path)));
  });
});

test('fetchGithubSkill on an explicit SKILL.md URL stays single-file (no contents-API call)', async () => {
  let listedContents = false;
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      listedContents = true;
      return new Response('[]', { status: 200 });
    }
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/solo/SKILL.md') {
      return new Response('---\nname: solo\ndescription: Just one file\n---\n\nSolo body.', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const fetched = await fetchGithubSkill('https://github.com/o/r/blob/main/skills/solo/SKILL.md');
    assert.equal(fetched.content, 'Solo body.');
    assert.equal(fetched.files, undefined, 'an explicit .md import has no extra files');
    assert.equal(listedContents, false, 'an explicit .md URL must never hit the contents API');
  });
});

test('fetchGithubSkill enforces the max-file cap (a large repo cannot blow up an import)', async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/big/SKILL.md') {
      return new Response('---\nname: big\ndescription: many files\n---\n\nbody', { status: 200 });
    }
    if (url === 'https://api.github.com/repos/o/r/contents/skills/big?ref=main') {
      return new Response(
        JSON.stringify([
          { type: 'file', name: 'a.md', path: 'skills/big/a.md', size: 5, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/big/a.md' },
          { type: 'file', name: 'b.md', path: 'skills/big/b.md', size: 5, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/big/b.md' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (/\/skills\/big\/[ab]\.md$/.test(url)) return new Response('x', { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    await assert.rejects(
      fetchGithubSkill('https://github.com/o/r/tree/main/skills/big', { maxFiles: 1 }),
      /more than 1 files/,
    );
  });
});

// ── parseMarketplaceImport (pure, offline) ───────────────────────────────────
// Note: the marketplace network resolver fetchMarketplaceSkills() is still verified manually against a
// real repo — only its pure parser and the route's 400 path run offline. fetchGithubSkill, by contrast,
// IS exercised offline above via a stubbed globalThis.fetch (the SYM-50 sibling-file import path).

test('parseMarketplaceImport reads the two pasted /plugin commands', () => {
  const spec = parseMarketplaceImport(
    '/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill\n/plugin install ui-ux-pro-max@ui-ux-pro-max-skill',
  );
  assert.deepEqual(spec, {
    owner: 'nextlevelbuilder',
    repo: 'ui-ux-pro-max-skill',
    plugin: 'ui-ux-pro-max',
    marketplace: 'ui-ux-pro-max-skill',
  });
});

test('parseMarketplaceImport accepts a single marketplace-add line (import all plugins)', () => {
  const spec = parseMarketplaceImport('/plugin marketplace add owner/repo');
  assert.equal(spec.owner, 'owner');
  assert.equal(spec.repo, 'repo');
  assert.equal(spec.plugin, undefined);
});

test('parseMarketplaceImport accepts a bare owner/repo', () => {
  assert.deepEqual(parseMarketplaceImport('owner/repo'), { owner: 'owner', repo: 'repo', plugin: undefined, marketplace: undefined });
});

test('parseMarketplaceImport accepts a full GitHub repo URL', () => {
  const spec = parseMarketplaceImport('https://github.com/owner/repo.git');
  assert.equal(spec.owner, 'owner');
  assert.equal(spec.repo, 'repo'); // .git suffix stripped
});

test('parseMarketplaceImport throws on unparseable input', () => {
  assert.throws(() => parseMarketplaceImport(''));
  assert.throws(() => parseMarketplaceImport('garbage'));
  // An install line alone names a marketplace, not a resolvable owner/repo.
  assert.throws(() => parseMarketplaceImport('/plugin install foo@bar'));
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

test('materializeSkills writes nested extra files preserving their relative paths', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-skills-'));
  gitInit(worktree);
  try {
    await materializeSkills(worktree, [
      mkSkill({
        name: 'Multi',
        content: 'body',
        files: [
          { path: 'reference.md', content: 'ref body' },
          { path: 'scripts/build.sh', content: 'echo build' },
        ],
      }),
    ]);
    const base = path.join(worktree, '.claude', 'skills', 'multi');
    assert.ok(fs.existsSync(path.join(base, 'SKILL.md')), 'SKILL.md is written');
    assert.equal(fs.readFileSync(path.join(base, 'reference.md'), 'utf8'), 'ref body');
    // The nested directory from the relative path is created.
    assert.equal(fs.readFileSync(path.join(base, 'scripts', 'build.sh'), 'utf8'), 'echo build');
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
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

  // install with no command → 400 (does not hit the network)
  res = await projectRoutes.request(`/${project.id}/skills/install`, json({}));
  assert.equal(res.status, 400);

  // install with an unparseable command → 400 before any fetch
  res = await projectRoutes.request(`/${project.id}/skills/install`, json({ command: 'garbage' }));
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
