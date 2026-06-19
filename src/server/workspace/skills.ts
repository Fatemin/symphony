import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ProjectSkill } from '../../shared/types';
import { stripFrontMatter } from '../core/githubSkill';
import { log } from '../observability/logger';
import { git } from './git';

// Claude Code auto-discovers project skills from <cwd>/.claude/skills/<slug>/SKILL.md (no CLI flag).
// We own that directory inside the worktree: every dispatch wipes + rewrites it so a reused worktree
// reflects the current DB (added/removed/disabled skills), and we exclude it from git so the agent
// can't accidentally commit it.
const SKILLS_REL_DIR = path.join('.claude', 'skills');
const GIT_EXCLUDE_ENTRY = '.claude/skills/';

/** Slugify a skill name into a safe directory + front-matter name: lowercase [a-z0-9-]. */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'skill';
}

/**
 * Build a valid SKILL.md: synthesized YAML front matter (name + description, both required by the
 * CLI) followed by the stored body. Any front matter already present in the stored content is
 * stripped first so the slug/description from the DB row is authoritative.
 */
export function buildSkillMarkdown(
  skill: Pick<ProjectSkill, 'name' | 'description' | 'content'>,
  slug = skillSlug(skill.name),
): string {
  const frontMatter = stringifyYaml({
    name: slug,
    description: skill.description?.trim() || skill.name.trim() || slug,
  }).trim();
  const body = stripFrontMatter(skill.content ?? '').trim();
  return `---\n${frontMatter}\n---\n\n${body}\n`;
}

/**
 * Write a project's enabled skills into <worktree>/.claude/skills. Idempotent + safe to call every
 * run. Path traversal is rejected (Safety Invariant §9.5): every skill dir + extra file must resolve
 * inside the skills root. When there are no enabled skills the worktree's skills dir is left
 * untouched, so a repo that ships its own committed `.claude/skills` is not clobbered by an unused
 * feature.
 */
export async function materializeSkills(worktreePath: string, skills: ProjectSkill[]): Promise<void> {
  const enabled = skills.filter((s) => s.enabled);
  const skillsRoot = path.resolve(worktreePath, SKILLS_REL_DIR);

  if (enabled.length === 0) {
    // Nothing to install. Clean up stale skills only when Symphony previously materialized here (the
    // git-exclude marker proves it owns the dir) — never delete a repo's own committed .claude/skills.
    if (await excludeHasSkillsEntry(worktreePath)) fs.rmSync(skillsRoot, { recursive: true, force: true });
    return;
  }

  // Symphony owns this directory in the worktree — rewrite from scratch so removed/disabled skills
  // from a previous run disappear.
  fs.rmSync(skillsRoot, { recursive: true, force: true });
  fs.mkdirSync(skillsRoot, { recursive: true });

  const usedSlugs = new Set<string>();
  for (const skill of enabled) {
    const slug = uniqueSlug(skillSlug(skill.name), usedSlugs);
    const dir = path.resolve(skillsRoot, slug);
    assertInside(skillsRoot, dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), buildSkillMarkdown(skill, slug));
    for (const file of skill.files) {
      const target = path.resolve(dir, file.path);
      assertInside(dir, target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
  }

  await excludeSkillsFromGit(worktreePath);
  log.debug('skills materialized', { worktreePath, count: enabled.length });
}

/** Disambiguate slugs that collide after sanitization (e.g. "My Skill" vs "my skill"). */
function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

/** Safety Invariant (§9.5): `target` must resolve inside `root` — reject traversal via the name. */
function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`skill path escapes its directory: ${target} not under ${root}`);
  }
}

/**
 * Idempotently append `.claude/skills/` to the worktree's git exclude file so the agent's commits
 * never capture materialized skills. info/exclude is shared across a repo's worktrees, which is fine
 * because every run re-materializes there. Best-effort: a git failure must not block the pipeline.
 */
async function excludeSkillsFromGit(worktreePath: string): Promise<void> {
  const excludePath = await gitExcludePath(worktreePath);
  if (!excludePath) return;
  let existing = '';
  try {
    existing = fs.readFileSync(excludePath, 'utf8');
  } catch {
    /* exclude file may not exist yet */
  }
  if (existing.split('\n').some((line) => line.trim() === GIT_EXCLUDE_ENTRY)) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${GIT_EXCLUDE_ENTRY}\n`);
}

/** True when a previous run already excluded .claude/skills — i.e. Symphony owns the dir here. */
async function excludeHasSkillsEntry(worktreePath: string): Promise<boolean> {
  const excludePath = await gitExcludePath(worktreePath);
  if (!excludePath) return false;
  try {
    return fs.readFileSync(excludePath, 'utf8').split('\n').some((line) => line.trim() === GIT_EXCLUDE_ENTRY);
  } catch {
    return false;
  }
}

/** Resolve the worktree's git info/exclude path (null on a non-git dir). */
async function gitExcludePath(worktreePath: string): Promise<string | null> {
  const res = await git(['rev-parse', '--git-path', 'info/exclude'], worktreePath);
  return res.ok ? path.resolve(worktreePath, res.stdout.trim()) : null;
}
