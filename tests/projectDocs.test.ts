import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers/env';

const env = setupEnv();

const { createProject, getProject, updateProject } = await import('../src/server/repo/projects');
const { projectRoutes } = await import('../src/server/http/routes/projects');

test.after(() => env.cleanup());

/** Build a throwaway on-disk "repo" (just a directory) with the given files, under the test root. */
function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(env.root, 'docs-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

type Listing = { directories: string[]; files: { path: string; name: string; dir: string }[] };
type Content = { path: string; name: string; content: string };
type Config = { docs: { directories: string[] }; agent: { max_turns?: number } };

const docsDirs = (config: unknown) => (config as Config).docs.directories;

test('config round-trip: docs.directories survives serialize → parse and does not drop siblings', () => {
  const project = createProject({ name: 'Docs Config', key: 'DCF', repo_path: env.repoPath });
  // parseProjectConfig seeds the default for every (even pre-existing) project.
  assert.deepEqual(docsDirs(getProject(project.id)!.config), ['docs']);

  // The config blob is replaced wholesale on save, so this guards the merge gotcha: docs must survive
  // alongside another section rather than being stripped (which is what happens if mergeDocs is missing).
  updateProject(project.id, {
    config: { agent: { max_turns: 5 }, docs: { directories: ['docs', 'guides', 'reference'] } },
  });
  const after = getProject(project.id)!;
  assert.deepEqual(docsDirs(after.config), ['docs', 'guides', 'reference']);
  assert.equal((after.config as Config).agent.max_turns, 5);

  // Normalization: blanks/dupes/leading-slash/`..` are cleaned out.
  updateProject(project.id, {
    config: { docs: { directories: ['docs', 'docs', '/abs', '  ', '../escape', 'sub/dir'] } },
  });
  assert.deepEqual(docsDirs(getProject(project.id)!.config), ['docs', 'abs', 'sub/dir']);
});

test('GET /:id/docs lists allow-listed files and respects configured directories', async () => {
  const repo = makeRepo({
    'docs/PRD.md': '# PRD',
    'docs/guide/intro.md': '# Intro',
    'docs/notes.bin': 'binary nope',
    'docs/.hidden.md': 'hidden nope',
    'guides/extra.md': '# Extra',
    'README.md': '# root readme (outside docs)',
  });
  const project = createProject({ name: 'Docs List', key: 'DLS', repo_path: repo });

  const res = await projectRoutes.request(`/${project.id}/docs`);
  assert.equal(res.status, 200);
  const listing = (await res.json()) as Listing;
  const paths = listing.files.map((f) => f.path);
  assert.deepEqual(listing.directories, ['docs']);
  assert.ok(paths.includes('docs/PRD.md'));
  assert.ok(paths.includes('docs/guide/intro.md'), 'walks nested directories');
  assert.ok(!paths.includes('docs/notes.bin'), 'skips non-allow-listed extensions');
  assert.ok(!paths.some((p) => p.includes('.hidden')), 'skips dotfiles');
  assert.ok(!paths.includes('guides/extra.md'), 'ignores unconfigured directories');
  assert.ok(!paths.includes('README.md'), 'root files outside docs/ are not listed');

  // Adding a directory surfaces its docs immediately (default ['docs'] → ['docs','guides']).
  updateProject(project.id, { config: { docs: { directories: ['docs', 'guides'] } } });
  const res2 = await projectRoutes.request(`/${project.id}/docs`);
  const listing2 = (await res2.json()) as Listing;
  assert.deepEqual(listing2.directories, ['docs', 'guides']);
  assert.ok(listing2.files.map((f) => f.path).includes('guides/extra.md'));
});

test('GET /:id/docs/content reads a doc and is hardened against traversal', async () => {
  const repo = makeRepo({
    'docs/PRD.md': '# PRD\nhello world',
    'docs/data.bin': 'binary',
    'secret.env': 'TOKEN=shh',
    'NOTES.md': '# root notes',
  });
  const project = createProject({ name: 'Docs Content', key: 'DCT', repo_path: repo });
  const read = (p: string) =>
    projectRoutes.request(`/${project.id}/docs/content?path=${encodeURIComponent(p)}`);

  const ok = await read('docs/PRD.md');
  assert.equal(ok.status, 200);
  const doc = (await ok.json()) as Content;
  assert.equal(doc.path, 'docs/PRD.md');
  assert.equal(doc.name, 'PRD.md');
  assert.match(doc.content, /hello world/);

  assert.equal((await read('docs/../secret.env')).status, 400, 'rejects ../ traversal');
  assert.equal((await read('/etc/passwd')).status, 400, 'rejects absolute paths');
  assert.equal((await read('NOTES.md')).status, 400, 'rejects files outside the configured dirs');
  assert.equal((await read('docs/data.bin')).status, 400, 'rejects disallowed extensions');
  assert.equal((await read('')).status, 400, 'rejects a missing path param');
  assert.equal((await read('docs/missing.md')).status, 404, 'missing file is 404');
});

test('graceful states: null repo_path → empty listing, missing project/file → 404', async () => {
  const noRepo = createProject({ name: 'No Repo', key: 'NRP' }); // repo_path defaults to null
  const res = await projectRoutes.request(`/${noRepo.id}/docs`);
  assert.equal(res.status, 200);
  const listing = (await res.json()) as Listing;
  assert.deepEqual(listing.files, []);
  assert.deepEqual(listing.directories, ['docs']);

  // Reading content without a linked repo is a 404 (nothing to read), not a 500.
  assert.equal((await projectRoutes.request(`/${noRepo.id}/docs/content?path=docs/x.md`)).status, 404);

  // Unknown project on both endpoints.
  assert.equal((await projectRoutes.request('/nope/docs')).status, 404);
  assert.equal((await projectRoutes.request('/nope/docs/content?path=docs/x.md')).status, 404);
});
