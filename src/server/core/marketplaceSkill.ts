import {
  fetchGithubSkill,
  SkillNotFoundError,
  type FetchedSkill,
  API,
  RAW,
  ghFetch,
  seg,
  encodePath,
  assertNotRateLimited,
} from './githubSkill';

/**
 * Import Claude Code marketplace plugins' skills from GitHub (SYM-17). A user pastes the two
 * commands Claude Code prints for a marketplace plugin, e.g.
 *
 *   /plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill
 *   /plugin install ui-ux-pro-max@ui-ux-pro-max-skill
 *
 * `parseMarketplaceImport` turns that paste (or a bare `owner/repo`, or a github repo URL) into a
 * `MarketplaceSpec`; `fetchMarketplaceSkills` resolves it against the repo's
 * `.claude-plugin/marketplace.json` and returns one FetchedSkill per `<pluginRoot>/skills/<slug>`.
 */

export interface MarketplaceSpec {
  owner: string;
  repo: string;
  /** Plugin name from the `install <plugin>@<marketplace>` line, if given (else import all plugins). */
  plugin?: string;
  /** Marketplace name from the same line — redundant with the repo, kept for diagnostics. */
  marketplace?: string;
}

// ── parsing (pure, offline-testable) ─────────────────────────────────────────

/**
 * Parse the pasted /plugin commands into a MarketplaceSpec. Tolerates a leading slash or not, the
 * two lines in either order, and a single line on its own; also accepts a bare `owner/repo` or a
 * github.com repo URL with no commands at all. Throws a clear error when no repo can be found.
 */
export function parseMarketplaceImport(text: string): MarketplaceSpec {
  const raw = (text ?? '').trim();
  if (!raw) throw new Error('paste the /plugin commands (or an owner/repo)');

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let ownerRepo: { owner: string; repo: string } | null = null;
  let plugin: string | undefined;
  let marketplace: string | undefined;

  for (const line of lines) {
    const add = line.match(/^\/?plugin\s+marketplace\s+add\s+(\S+)/i);
    if (add?.[1]) {
      ownerRepo = parseOwnerRepo(add[1]);
      continue;
    }
    const install = line.match(/^\/?plugin\s+install\s+(\S+)/i);
    if (install?.[1]) {
      const [pluginName, marketplaceName] = install[1].split('@');
      plugin = pluginName || undefined;
      marketplace = marketplaceName || undefined;
    }
  }

  // No `marketplace add` line: if the paste isn't a /plugin command at all, treat it as a bare
  // owner/repo or repo URL. (An `install` line alone names a marketplace, not a resolvable repo.)
  if (!ownerRepo) {
    const isCommand = lines.some((l) => /^\/?plugin\s+/i.test(l));
    if (!isCommand && lines[0]) ownerRepo = parseOwnerRepo(lines[0]);
  }
  if (!ownerRepo) {
    throw new Error(
      'could not find a marketplace repo — include the "/plugin marketplace add <owner>/<repo>" line, or paste an owner/repo or GitHub repo URL',
    );
  }
  return { owner: ownerRepo.owner, repo: ownerRepo.repo, plugin, marketplace };
}

/** Accept `owner/repo`, a github.com repo URL, or a `git@github.com:owner/repo` ssh URL. */
function parseOwnerRepo(arg: string): { owner: string; repo: string } {
  const trimmed = (arg ?? '').trim();
  if (/^https?:\/\//i.test(trimmed) || /^git@/i.test(trimmed)) return parseRepoUrl(trimmed);
  const parts = trimmed.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: stripGitSuffix(parts[1]) };
  }
  throw new Error(`expected an "owner/repo" or a GitHub repo URL, got "${arg}"`);
}

function parseRepoUrl(url: string): { owner: string; repo: string } {
  let u: URL;
  try {
    u = new URL(url.replace(/^git@github\.com:/i, 'https://github.com/'));
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error(`unsupported host "${host}" — provide a github.com repo URL`);
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`could not find owner/repo in ${url}`);
  }
  return { owner: parts[0], repo: stripGitSuffix(parts[1]) };
}

const stripGitSuffix = (repo: string) => repo.replace(/\.git$/i, '');

// ── network resolution (NOT exercised by the offline test suite) ─────────────

// GitHub repos default to one of these; we try in order when the default branch is unknown.
const BRANCHES = ['main', 'master'];

interface MarketplacePlugin {
  name?: string;
  description?: string;
  source?: string | { source?: string; repo?: string; path?: string };
}
interface MarketplaceJson {
  name?: string;
  plugins?: MarketplacePlugin[];
}
interface PluginRoot {
  owner: string;
  repo: string;
  path: string;
}

/**
 * Resolve a MarketplaceSpec to its plugins' skills. Reads `.claude-plugin/marketplace.json`, picks
 * the requested plugin (or all/sole plugins), and lists each plugin root's `skills/` directory via
 * the GitHub contents API. Falls back to the repo's own `skills/` when there is no marketplace.json,
 * and (SYM-52) to a flat single-skill layout — a SKILL.md at the plugin/repo root or directly under
 * skills/ (no `<name>/` subdir) — when the `skills/<name>/` listing yields nothing, so a single-skill
 * repo installs. Honors a GITHUB_TOKEN auth header (the unauthenticated contents API is rate-limited
 * to ~60/hour).
 */
export async function fetchMarketplaceSkills(spec: MarketplaceSpec): Promise<FetchedSkill[]> {
  const marketplace = await fetchMarketplaceJson(spec.owner, spec.repo);

  if (!marketplace) {
    // No marketplace.json — treat the repo itself as the skills source: first the skills/<name>/
    // subdir layout, then (SYM-52) a flat SKILL.md at the repo root or directly under skills/.
    const skills = await collectSkills(spec.owner, spec.repo, 'skills', BRANCHES);
    if (skills.length) return skills;
    const flat = await collectFlatSkills(spec.owner, spec.repo, '', BRANCHES);
    if (flat.length) return flat;
    throw new Error(
      `no skills found in ${spec.owner}/${spec.repo} — expected a SKILL.md at the repo root, directly under skills/, or in skills/<name>/ subdirectories`,
    );
  }

  const plugins = Array.isArray(marketplace.json.plugins) ? marketplace.json.plugins : [];
  const selected = spec.plugin ? plugins.filter((p) => p?.name === spec.plugin) : plugins;
  if (!selected.length) {
    throw new Error(
      spec.plugin
        ? `plugin "${spec.plugin}" not found in the ${spec.owner}/${spec.repo} marketplace`
        : `the ${spec.owner}/${spec.repo} marketplace lists no plugins`,
    );
  }

  const all: FetchedSkill[] = [];
  for (const plugin of selected) {
    const root = resolvePluginRoot(plugin, spec);
    const sameRepo = root.owner === spec.owner && root.repo === spec.repo;
    // Same-repo plugins live on the branch the marketplace.json came from; cross-repo ones we probe.
    const branches = sameRepo
      ? [marketplace.branch, ...BRANCHES.filter((b) => b !== marketplace.branch)]
      : BRANCHES;
    const nested = await collectSkills(root.owner, root.repo, joinPath(root.path, 'skills'), branches);
    if (nested.length) {
      all.push(...nested);
    } else {
      // SYM-52: a single-skill plugin keeps its SKILL.md at the plugin root or directly under skills/
      // (no <name>/ subdir) — fall back to a flat probe before giving up.
      all.push(...(await collectFlatSkills(root.owner, root.repo, root.path, branches)));
    }
  }
  if (!all.length) {
    throw new Error(
      `no skills found under the selected plugin(s) in ${spec.owner}/${spec.repo} — expected SKILL.md files under skills/<name>/, directly under skills/, or at the plugin root`,
    );
  }
  return dedupeByName(all);
}

/** Map a plugin's `source` to a {owner, repo, path}. Handles "./"/path strings and a github object. */
function resolvePluginRoot(plugin: MarketplacePlugin, spec: MarketplaceSpec): PluginRoot {
  const source = plugin?.source;
  if (source == null || source === '' || source === '.' || source === './') {
    return { owner: spec.owner, repo: spec.repo, path: '' };
  }
  if (typeof source === 'string') {
    return { owner: spec.owner, repo: spec.repo, path: normalizeRelPath(source) };
  }
  if (typeof source === 'object') {
    const kind = typeof source.source === 'string' ? source.source : undefined;
    if (kind === 'github' && typeof source.repo === 'string') {
      const { owner, repo } = parseOwnerRepo(source.repo);
      return { owner, repo, path: normalizeRelPath(typeof source.path === 'string' ? source.path : '') };
    }
    if (kind && (kind.startsWith('.') || kind.startsWith('/'))) {
      return { owner: spec.owner, repo: spec.repo, path: normalizeRelPath(kind) };
    }
    if (typeof source.path === 'string') {
      return { owner: spec.owner, repo: spec.repo, path: normalizeRelPath(source.path) };
    }
  }
  throw new Error(
    `unsupported plugin source ${JSON.stringify(source)} in the ${spec.owner}/${spec.repo} marketplace`,
  );
}

/** Read .claude-plugin/marketplace.json, trying refs main then master. null = absent on all refs. */
async function fetchMarketplaceJson(
  owner: string,
  repo: string,
): Promise<{ json: MarketplaceJson; branch: string } | null> {
  for (const branch of BRANCHES) {
    const url = `${RAW}/${seg(owner)}/${seg(repo)}/${seg(branch)}/.claude-plugin/marketplace.json`;
    const res = await ghFetch(url, 'application/json');
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(`could not fetch marketplace.json from ${url}: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    try {
      return { json: JSON.parse(text) as MarketplaceJson, branch };
    } catch {
      throw new Error(`.claude-plugin/marketplace.json in ${owner}/${repo} is not valid JSON`);
    }
  }
  return null;
}

/** List the immediate subdirectories of `dir` (each is one skill) and fetch their SKILL.md. */
async function collectSkills(
  owner: string,
  repo: string,
  dir: string,
  branches: string[],
): Promise<FetchedSkill[]> {
  const entries = await listSkillDirs(owner, repo, dir, branches);
  const skills: FetchedSkill[] = [];
  for (const entry of entries) {
    try {
      skills.push(await fetchGithubSkill(entry));
    } catch {
      // A subdirectory without a SKILL.md isn't a skill — skip it rather than fail the import.
    }
  }
  return skills;
}

/**
 * SYM-52 flat/root fallback: probe `<base>/SKILL.md` then `<base>/skills/SKILL.md` (across `branches`)
 * for a single-skill layout that `collectSkills` — which only lists `skills/<name>/` subdirs — misses.
 * Returns the first hit as a one-element list (with its sibling files), or [] if none found. A real
 * error (rate limit, non-404 failure) propagates rather than being read as "absent". The whole probed
 * directory is recursed for sibling files, bounded by `fetchGithubSkill`'s file/byte/depth caps.
 */
async function collectFlatSkills(
  owner: string,
  repo: string,
  base: string,
  branches: string[],
): Promise<FetchedSkill[]> {
  for (const branch of branches) {
    for (const sub of ['', 'skills']) {
      const dir = joinPath(base, sub);
      const treeUrl =
        `https://github.com/${seg(owner)}/${seg(repo)}/tree/${seg(branch)}` +
        (dir ? `/${encodePath(dir)}` : '');
      try {
        return [await fetchGithubSkill(treeUrl)];
      } catch (e) {
        if (e instanceof SkillNotFoundError) continue; // not here — try the next location
        throw e;
      }
    }
  }
  return [];
}

/** Contents-API listing of `dir`; returns each subdirectory's github.com tree URL (encodes the ref). */
async function listSkillDirs(
  owner: string,
  repo: string,
  dir: string,
  branches: string[],
): Promise<string[]> {
  for (const branch of branches) {
    const url = `${API}/repos/${seg(owner)}/${seg(repo)}/contents/${encodePath(dir)}?ref=${seg(branch)}`;
    const res = await ghFetch(url, 'application/vnd.github+json');
    if (res.status === 404) continue;
    assertNotRateLimited(res);
    if (!res.ok) {
      throw new Error(`could not list ${dir} in ${owner}/${repo}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .filter((e): e is { type: string; html_url: string } => {
        return !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'dir' &&
          typeof (e as { html_url?: unknown }).html_url === 'string';
      })
      .map((e) => e.html_url);
  }
  return [];
}

function dedupeByName(skills: FetchedSkill[]): FetchedSkill[] {
  const seen = new Set<string>();
  const out: FetchedSkill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/');
const normalizeRelPath = (p: string) => p.replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
