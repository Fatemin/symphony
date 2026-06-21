import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillCopyResult } from '../src/shared/types';
import { setupEnv } from './helpers/env';

// Env must be set before importing any server module (they read paths from env at import).
const env = setupEnv();

const { parseGithubSkillUrl, parseGithubSkillRef, fetchGithubSkill, stripFrontMatter } = await import(
  '../src/server/core/githubSkill'
);
const { parseMarketplaceImport, fetchMarketplaceSkills, fetchRepoSkills } = await import(
  '../src/server/core/marketplaceSkill'
);
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

/** A JSON 200 Response (the GitHub repo-metadata / contents-listing shape). */
const ghJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

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
  assert.throws(() => parseGithubSkillUrl('https://github.com/o')); // owner only, no repo
  // SYM-52: a bare repo URL no longer throws — it resolves to a bareRepo ref (empty rawSkillUrl).
  assert.equal(parseGithubSkillUrl('https://github.com/o/r'), '');
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

test('parseGithubSkillRef accepts a bare repo URL as a default-branch directory ref (SYM-52)', () => {
  const bare = parseGithubSkillRef('https://github.com/nextlevelbuilder/ui-ux-pro-max-skill');
  assert.deepEqual(
    { bareRepo: bare.bareRepo, isDirectory: bare.isDirectory, owner: bare.owner, repo: bare.repo, ref: bare.ref, dir: bare.dir, rawSkillUrl: bare.rawSkillUrl },
    { bareRepo: true, isDirectory: true, owner: 'nextlevelbuilder', repo: 'ui-ux-pro-max-skill', ref: '', dir: '', rawSkillUrl: '' },
  );
  // A trailing slash and a `.git` suffix are tolerated; a www. host works too.
  assert.equal(parseGithubSkillRef('https://github.com/o/r.git/').repo, 'r');
  assert.equal(parseGithubSkillRef('https://www.github.com/o/r').bareRepo, true);
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

// ── fetchGithubSkill: bare repo URL → default branch + flat/root probe (offline, SYM-52) ──

test('fetchGithubSkill on a bare repo URL resolves the default branch and imports the root SKILL.md', async () => {
  const SKILL_MD = '---\nname: root-skill\ndescription: at the repo root\n---\n\nRoot body.';
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    // The repo's default branch is NOT main — the bare-repo path must honor it.
    if (url === 'https://api.github.com/repos/o/r') {
      return new Response(JSON.stringify({ default_branch: 'trunk' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://raw.githubusercontent.com/o/r/trunk/SKILL.md') {
      return new Response(SKILL_MD, { status: 200 });
    }
    // Root contents listing has NO trailing slash before the query string (SYM-52).
    if (url === 'https://api.github.com/repos/o/r/contents?ref=trunk') {
      return new Response(
        JSON.stringify([
          { type: 'file', name: 'SKILL.md', path: 'SKILL.md', size: SKILL_MD.length, download_url: 'https://raw.githubusercontent.com/o/r/trunk/SKILL.md' },
          { type: 'file', name: 'reference.md', path: 'reference.md', size: 8, download_url: 'https://raw.githubusercontent.com/o/r/trunk/reference.md' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://raw.githubusercontent.com/o/r/trunk/reference.md') {
      return new Response('ref body', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const fetched = await fetchGithubSkill('https://github.com/o/r');
    assert.equal(fetched.name, 'root-skill');
    assert.equal(fetched.content, 'Root body.');
    assert.equal(fetched.source_url, 'https://github.com/o/r'); // the user's URL, not the resolved raw
    assert.deepEqual(fetched.files?.map((f) => f.path), ['reference.md']); // root siblings, SKILL.md excluded
  });
});

test('fetchGithubSkill on a bare repo URL falls back to skills/SKILL.md when the root has none', async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/o/r') {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Root SKILL.md is a 404 → SkillNotFoundError → probe skills/SKILL.md next (no contents call at root).
    if (url === 'https://raw.githubusercontent.com/o/r/main/SKILL.md') {
      return new Response('not found', { status: 404 });
    }
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/SKILL.md') {
      return new Response('---\nname: flat\ndescription: under skills/\n---\n\nFlat body.', { status: 200 });
    }
    if (url === 'https://api.github.com/repos/o/r/contents/skills?ref=main') {
      return new Response(
        JSON.stringify([
          { type: 'file', name: 'SKILL.md', path: 'skills/SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/SKILL.md' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const fetched = await fetchGithubSkill('https://github.com/o/r');
    assert.equal(fetched.name, 'flat');
    assert.equal(fetched.content, 'Flat body.');
    assert.equal(fetched.files, undefined, 'only SKILL.md under skills/ → no sibling files');
  });
});

test('fetchGithubSkill on a bare repo URL with no SKILL.md anywhere throws a clear error', async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/o/r') {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 }); // neither root nor skills/ has a SKILL.md
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    await assert.rejects(
      // SYM-58: the shared terminal error names every layout tried + the GITHUB_TOKEN remedy (and no
      // longer points at "Install from Claude Code" — the bare URL now resolves skills/<name>/ itself).
      fetchGithubSkill('https://github.com/o/r'),
      /no SKILL\.md found in o\/r@main — tried the repo root, skills\/SKILL\.md, and skills\/<name>\/ subdirectories.*GITHUB_TOKEN/s,
    );
  });
});

// ── parseMarketplaceImport (pure, offline) ───────────────────────────────────
// Note: the marketplace network resolver fetchMarketplaceSkills() is verified manually against a real
// repo; only its pure parser, the route's 400 path, and the SYM-52 flat-fallback case (below) run
// offline. fetchGithubSkill is likewise exercised offline via a stubbed globalThis.fetch (the SYM-50
// sibling-file import and the SYM-52 bare-repo paths above).

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

// ── fetchMarketplaceSkills: flat single-skill fallback (offline via stubbed fetch, SYM-52) ─

test('fetchMarketplaceSkills falls back to a root SKILL.md when no skills/<name>/ dirs exist', async () => {
  const MP = JSON.stringify({ name: 'mp', plugins: [{ name: 'p', source: '.' }] });
  const SKILL = '---\nname: solo-plugin\ndescription: a flat single-skill plugin\n---\n\nFlat plugin body.';
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://raw.githubusercontent.com/o/r/main/.claude-plugin/marketplace.json') {
      return new Response(MP, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // The plugin's skills/ dir has no <name>/ subdirs → collectSkills finds nothing.
    if (url.startsWith('https://api.github.com/repos/o/r/contents/skills?ref=')) {
      return new Response('not found', { status: 404 });
    }
    // Flat fallback: the plugin root (source '.') holds SKILL.md directly.
    if (url === 'https://raw.githubusercontent.com/o/r/main/SKILL.md') {
      return new Response(SKILL, { status: 200 });
    }
    if (url === 'https://api.github.com/repos/o/r/contents?ref=main') {
      return new Response(
        JSON.stringify([
          { type: 'file', name: 'SKILL.md', path: 'SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/SKILL.md' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const skills = await fetchMarketplaceSkills({ owner: 'o', repo: 'r', plugin: 'p' });
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, 'solo-plugin');
    assert.equal(skills[0]!.content, 'Flat plugin body.');
  });
});

// ── fetchRepoSkills: bare repo URL → unified root / flat / skills/<name>/ resolver (offline, SYM-58) ─

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name} body.`;

test('fetchRepoSkills imports every skill under skills/<name>/ for a bare repo URL (SYM-58)', async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/o/r') return ghJson({ default_branch: 'main' });
    // The flat probe finds nothing at the root or directly under skills/ → fall through to skills/<name>/.
    if (url === 'https://raw.githubusercontent.com/o/r/main/SKILL.md') return new Response('nf', { status: 404 });
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/SKILL.md') return new Response('nf', { status: 404 });
    // collectSkills lists skills/ and finds two <name>/ subdirs, each with its own SKILL.md.
    if (url === 'https://api.github.com/repos/o/r/contents/skills?ref=main') {
      return ghJson([
        { type: 'dir', name: 'alpha', path: 'skills/alpha', html_url: 'https://github.com/o/r/tree/main/skills/alpha' },
        { type: 'dir', name: 'beta', path: 'skills/beta', html_url: 'https://github.com/o/r/tree/main/skills/beta' },
      ]);
    }
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md') return new Response(skillMd('alpha'), { status: 200 });
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/beta/SKILL.md') return new Response(skillMd('beta'), { status: 200 });
    if (url === 'https://api.github.com/repos/o/r/contents/skills/alpha?ref=main') {
      return ghJson([{ type: 'file', name: 'SKILL.md', path: 'skills/alpha/SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md' }]);
    }
    if (url === 'https://api.github.com/repos/o/r/contents/skills/beta?ref=main') {
      return ghJson([{ type: 'file', name: 'SKILL.md', path: 'skills/beta/SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/beta/SKILL.md' }]);
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const skills = await fetchRepoSkills('o', 'r', 'https://github.com/o/r');
    assert.deepEqual(skills.map((s) => s.name).sort(), ['alpha', 'beta']);
    // Each skill's source_url is its resolved tree URL (the subdir), not the bare repo URL.
    assert.ok(skills.every((s) => /skills\/(alpha|beta)$/.test(s.source_url)));
    // SKILL.md-only subdirs carry no extra sibling files.
    assert.ok(skills.every((s) => s.files === undefined));
  });
});

test('fetchRepoSkills returns the flat root skill before listing skills/<name>/ (SYM-58)', async () => {
  let listedSkillsDir = false;
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/o/r') return ghJson({ default_branch: 'main' });
    if (url === 'https://raw.githubusercontent.com/o/r/main/SKILL.md') return new Response(skillMd('root'), { status: 200 });
    if (url === 'https://api.github.com/repos/o/r/contents?ref=main') {
      return ghJson([{ type: 'file', name: 'SKILL.md', path: 'SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/SKILL.md' }]);
    }
    if (url.startsWith('https://api.github.com/repos/o/r/contents/skills?ref=')) {
      listedSkillsDir = true;
      return new Response('[]', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const skills = await fetchRepoSkills('o', 'r', 'https://github.com/o/r');
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, 'root');
    assert.equal(skills[0]!.source_url, 'https://github.com/o/r'); // the bare URL the user pasted
    assert.equal(listedSkillsDir, false, 'a flat root skill short-circuits before the skills/<name>/ listing');
  });
});

test('fetchRepoSkills throws the layouts + GITHUB_TOKEN error when a bare repo has no skill (SYM-58)', async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/o/r') return ghJson({ default_branch: 'main' });
    return new Response('not found', { status: 404 }); // no flat SKILL.md and no skills/<name>/ subdirs
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    await assert.rejects(
      fetchRepoSkills('o', 'r', 'https://github.com/o/r'),
      /no SKILL\.md found in o\/r@main — tried the repo root, skills\/SKILL\.md, and skills\/<name>\/ subdirectories.*GITHUB_TOKEN/s,
    );
  });
});

test('POST /skills/import on a bare repo URL imports every skills/<name>/ skill and returns the batch result (SYM-58)', async () => {
  const project = createProject({ name: 'Bare Import', key: 'BI', repo_path: env.repoPath });
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/o/r') return ghJson({ default_branch: 'main' });
    if (url === 'https://raw.githubusercontent.com/o/r/main/SKILL.md') return new Response('nf', { status: 404 });
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/SKILL.md') return new Response('nf', { status: 404 });
    if (url === 'https://api.github.com/repos/o/r/contents/skills?ref=main') {
      return ghJson([
        { type: 'dir', name: 'alpha', path: 'skills/alpha', html_url: 'https://github.com/o/r/tree/main/skills/alpha' },
        { type: 'dir', name: 'beta', path: 'skills/beta', html_url: 'https://github.com/o/r/tree/main/skills/beta' },
      ]);
    }
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md') return new Response(skillMd('alpha'), { status: 200 });
    if (url === 'https://raw.githubusercontent.com/o/r/main/skills/beta/SKILL.md') return new Response(skillMd('beta'), { status: 200 });
    if (url === 'https://api.github.com/repos/o/r/contents/skills/alpha?ref=main') {
      return ghJson([{ type: 'file', name: 'SKILL.md', path: 'skills/alpha/SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md' }]);
    }
    if (url === 'https://api.github.com/repos/o/r/contents/skills/beta?ref=main') {
      return ghJson([{ type: 'file', name: 'SKILL.md', path: 'skills/beta/SKILL.md', size: 10, download_url: 'https://raw.githubusercontent.com/o/r/main/skills/beta/SKILL.md' }]);
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  await withFetch(stub, async () => {
    const res = await projectRoutes.request(`/${project.id}/skills/import`, json({ url: 'https://github.com/o/r' }));
    assert.equal(res.status, 201);
    const result = (await res.json()) as { imported: { name: string; source: string }[]; skipped: unknown[] };
    assert.deepEqual(result.imported.map((s) => s.name).sort(), ['alpha', 'beta']);
    assert.deepEqual(result.skipped, []);
    assert.ok(result.imported.every((s) => s.source === 'github'), 'imported skills keep the github source');
    assert.equal(listProjectSkills(project.id).length, 2, 'both skills are persisted under the project');
  });
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

// ── cross-project skill copy (SYM-64) ────────────────────────────────────────

test('copying skills to other projects pushes new rows, skips duplicates, and guards inputs', async () => {
  const source = createProject({ name: 'Copy Source', key: 'CS', repo_path: env.repoPath });
  const target = createProject({ name: 'Copy Target', key: 'CT', repo_path: env.repoPath });
  const other = createProject({ name: 'Copy Other', key: 'CO', repo_path: env.repoPath });

  const manual = createProjectSkill({ project_id: source.id, name: 'house-style', description: 'how we write', content: 'Be terse.' });
  const fromGithub = createProjectSkill({
    project_id: source.id,
    name: 'lint-rules',
    content: 'Run lint.',
    source: 'github',
    source_url: 'https://github.com/o/r/blob/main/skills/lint/SKILL.md',
    enabled: false,
  });

  // (a) copy ALL skills (no skill_ids) into one target → both land, provenance preserved, 201.
  let res = await projectRoutes.request(`/${source.id}/skills/copy`, json({ target_project_ids: [target.id] }));
  assert.equal(res.status, 201);
  let result = (await res.json()) as SkillCopyResult;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.project_id, target.id);
  assert.equal(result.results[0]!.imported.length, 2);
  assert.equal(result.results[0]!.skipped.length, 0);
  const copied = listProjectSkills(target.id);
  assert.equal(copied.length, 2);
  const copiedGithub = copied.find((s) => s.name === 'lint-rules')!;
  assert.equal(copiedGithub.source, 'github'); // provenance preserved
  assert.equal(copiedGithub.source_url, fromGithub.source_url);
  assert.equal(copiedGithub.enabled, false); // disabled state preserved
  // It's a fresh row in the target, not a move — the source still has both skills.
  assert.equal(listProjectSkills(source.id).length, 2);

  // (b) re-copy to [target, other]: target already has both → both skipped; other receives both → 201.
  res = await projectRoutes.request(`/${source.id}/skills/copy`, json({ target_project_ids: [target.id, other.id] }));
  assert.equal(res.status, 201);
  result = (await res.json()) as SkillCopyResult;
  const targetRes = result.results.find((r) => r.project_id === target.id)!;
  assert.equal(targetRes.imported.length, 0);
  assert.equal(targetRes.skipped.length, 2);
  const otherRes = result.results.find((r) => r.project_id === other.id)!;
  assert.equal(otherRes.imported.length, 2);

  // (c) skill_ids filter copies only the selected subset.
  const subset = createProject({ name: 'Subset', key: 'SUB', repo_path: env.repoPath });
  res = await projectRoutes.request(
    `/${source.id}/skills/copy`,
    json({ target_project_ids: [subset.id], skill_ids: [manual.id] }),
  );
  assert.equal(res.status, 201);
  const subsetSkills = listProjectSkills(subset.id);
  assert.equal(subsetSkills.length, 1);
  assert.equal(subsetSkills[0]!.name, 'house-style');

  // (d) a list that includes the source id drops the self-target (no self-copy).
  const dropSelf = createProject({ name: 'Drop Self', key: 'DS', repo_path: env.repoPath });
  res = await projectRoutes.request(
    `/${source.id}/skills/copy`,
    json({ target_project_ids: [source.id, dropSelf.id] }),
  );
  assert.equal(res.status, 201);
  result = (await res.json()) as SkillCopyResult;
  assert.equal(result.results.length, 1); // only dropSelf — the source entry was dropped
  assert.equal(result.results[0]!.project_id, dropSelf.id);
  assert.equal(listProjectSkills(source.id).length, 2); // source still unchanged

  // (e) guards: empty/missing target_project_ids → 400; unknown source → 404; all-duplicate → 422.
  res = await projectRoutes.request(`/${source.id}/skills/copy`, json({ target_project_ids: [] }));
  assert.equal(res.status, 400);
  res = await projectRoutes.request(`/${source.id}/skills/copy`, json({}));
  assert.equal(res.status, 400);
  res = await projectRoutes.request(`/does-not-exist/skills/copy`, json({ target_project_ids: [target.id] }));
  assert.equal(res.status, 404);
  // target already holds every source skill → nothing imported → 422.
  res = await projectRoutes.request(`/${source.id}/skills/copy`, json({ target_project_ids: [target.id] }));
  assert.equal(res.status, 422);
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
