import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWorkspaceKey } from '../core/keys';
import { log } from '../observability/logger';
import { branchExists, currentBranch, git, gitOrThrow, isGitRepo } from './git';

export interface WorktreeSpec {
  /** The project's source git repository. */
  repoPath: string;
  /** Branch to fork the agent's work from (e.g. project default_branch). */
  baseBranch: string;
  /** Agent working branch. */
  branch: string;
  /** Absolute path where the worktree should live (under workspaceRoot). */
  worktreePath: string;
  /** Root that worktreePath must stay within (Safety Invariant §9.5). */
  workspaceRoot: string;
}

export interface EnsureResult {
  path: string;
  created: boolean;
}

/**
 * Safety Invariant 2 (§9.5): the worktree path must resolve inside the workspace root.
 * Throws otherwise. Prevents an issue key from escaping the sandbox via path traversal.
 */
export function assertInsideRoot(workspaceRoot: string, target: string): void {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`worktree path escapes workspace root: ${resolved} not under ${root}`);
  }
}

/** Compute the on-disk worktree path for an issue key. */
export function worktreePathFor(
  workspaceRoot: string,
  projectKey: string,
  issueKey: string,
): string {
  return path.join(
    workspaceRoot,
    sanitizeWorkspaceKey(projectKey),
    sanitizeWorkspaceKey(issueKey),
  );
}

/**
 * Create (or reuse) an isolated git worktree for one issue. Worktrees are preserved across
 * runs for the same issue (Symphony §9.1). Uses `git worktree add [-b branch] <path> <base>`,
 * which creates the branch at add-time — avoiding the in-worktree `checkout -b` conflict that
 * bit the previous implementation.
 */
export async function ensureWorktree(spec: WorktreeSpec): Promise<EnsureResult> {
  assertInsideRoot(spec.workspaceRoot, spec.worktreePath);

  if (!(await isGitRepo(spec.repoPath))) {
    throw new Error(`project repo_path is not a git repository: ${spec.repoPath}`);
  }

  // Reuse if a worktree already lives there.
  if (fs.existsSync(path.join(spec.worktreePath, '.git'))) {
    log.debug('worktree reused', { path: spec.worktreePath, branch: spec.branch });
    return { path: spec.worktreePath, created: false };
  }

  fs.mkdirSync(path.dirname(spec.worktreePath), { recursive: true });

  const exists = await branchExists(spec.repoPath, spec.branch);
  const args = exists
    ? ['worktree', 'add', spec.worktreePath, spec.branch]
    : ['worktree', 'add', '-b', spec.branch, spec.worktreePath, spec.baseBranch];
  await gitOrThrow(args, spec.repoPath);
  seedDependencyArtifacts(spec.repoPath, spec.worktreePath);

  log.info('worktree created', { path: spec.worktreePath, branch: spec.branch });
  return { path: spec.worktreePath, created: true };
}

const DEPENDENCY_SEED_DIRS = ['node_modules'];

/**
 * New git worktrees do not include ignored dependency trees. When the source checkout already has
 * one, seed the worktree with a local clone so agents do not spend each issue rediscovering and
 * reinstalling the same packages. This is best-effort; package managers can still repair drift.
 */
function seedDependencyArtifacts(repoPath: string, worktreePath: string): void {
  for (const name of DEPENDENCY_SEED_DIRS) {
    const source = path.join(repoPath, name);
    const target = path.join(worktreePath, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      fs.cpSync(source, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
        verbatimSymlinks: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
      log.info('dependency tree seeded into worktree', { source, target });
    } catch (e) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
      log.warn('dependency tree seed failed', { source, target, err: String(e) });
    }
  }
}

/** Remove an issue's worktree (and prune the registration). Best-effort. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (fs.existsSync(worktreePath)) {
    const r = await git(['worktree', 'remove', '--force', worktreePath], repoPath);
    if (!r.ok) {
      // Fall back to a manual delete + prune if git refuses (e.g. dirty state).
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (e) {
        log.warn('worktree manual remove failed', { worktreePath, err: String(e) });
      }
    }
  }
  await git(['worktree', 'prune'], repoPath);
}

export interface DiffFile {
  path: string;
  status: string; // M, A, D, R…
}

export interface BranchDiff {
  available: boolean;
  base: string;
  branch: string;
  stat: string;
  files: DiffFile[];
  patch: string;
  truncated: boolean;
}

const MAX_PATCH_BYTES = 200_000;

/**
 * Compute what an agent branch changed relative to its base, for the review gate. Uses the
 * three-dot range (`base...branch`) so it shows only the branch's own commits even if base moved.
 * Returns committed changes (the pipeline commits after implement + qa).
 */
export async function getBranchDiff(
  repoPath: string,
  base: string,
  branch: string,
): Promise<BranchDiff> {
  const empty: BranchDiff = { available: false, base, branch, stat: '', files: [], patch: '', truncated: false };
  if (!(await isGitRepo(repoPath)) || !(await branchExists(repoPath, branch))) return empty;

  const range = `${base}...${branch}`;
  const stat = await git(['diff', '--stat', range], repoPath);
  const nameStatus = await git(['diff', '--name-status', range], repoPath);
  const patchRes = await git(['diff', range], repoPath);

  const files: DiffFile[] = nameStatus.ok
    ? nameStatus.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const parts = l.split('\t');
          return { status: parts[0] ?? '?', path: parts[parts.length - 1] ?? '' };
        })
    : [];

  const full = patchRes.ok ? patchRes.stdout : '';
  const truncated = full.length > MAX_PATCH_BYTES;
  return {
    available: true,
    base,
    branch,
    stat: stat.ok ? stat.stdout.trim() : '',
    files,
    patch: truncated ? full.slice(0, MAX_PATCH_BYTES) : full,
    truncated,
  };
}

/** Stage + commit everything in the worktree. Returns false if there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await git(['add', '-A'], worktreePath);
  const status = await git(['status', '--porcelain'], worktreePath);
  if (status.ok && status.stdout.trim() === '') return false;
  const r = await git(['commit', '-m', message], worktreePath);
  return r.ok;
}

export interface MergeResult {
  ok: boolean;
  reason?: string;
  commit?: string;
}

/**
 * Merge an agent branch into its base in the main repo (the review-approval action). Safe by
 * construction: relies on git's own clobber protection — uncommitted changes that don't overlap
 * the branch's diff survive the merge untouched, and git refuses (naming the files) when they
 * do overlap. A dirty tree only hard-blocks when the base isn't checked out, because switching
 * branches would carry the dirt across. Aborts cleanly on conflict and restores the repo's
 * originally checked-out branch afterward so approving doesn't move the user's HEAD.
 */
export async function mergeAgentBranch(
  repoPath: string,
  base: string,
  branch: string,
  message: string,
): Promise<MergeResult> {
  if (!(await isGitRepo(repoPath))) return { ok: false, reason: 'project repo is not a git repository' };
  if (!(await branchExists(repoPath, branch))) return { ok: false, reason: `branch ${branch} not found` };

  const original = await currentBranch(repoPath); // null when detached

  const status = await git(['status', '--porcelain'], repoPath);
  const dirty = status.ok && status.stdout.trim() !== '';
  if (dirty && original !== base) {
    return {
      ok: false,
      reason: `repo at ${repoPath} has uncommitted changes and ${base} is not checked out — commit/stash them or merge manually`,
    };
  }

  if (original !== base) {
    const co = await git(['checkout', base], repoPath);
    if (!co.ok) return { ok: false, reason: `could not switch to ${base}: ${co.stderr.trim() || co.stdout.trim()}` };
  }

  const restore = async () => {
    if (original && original !== base) await git(['checkout', original], repoPath);
  };

  const merge = await git(['merge', '--no-ff', branch, '-m', message], repoPath);
  if (!merge.ok) {
    // If the merge never started (e.g. git's clobber protection refused), abort is a no-op.
    await git(['merge', '--abort'], repoPath);
    await restore();
    return { ok: false, reason: `merge failed — resolve manually: ${merge.stderr.trim() || merge.stdout.trim()}` };
  }

  const head = await git(['rev-parse', '--short', base], repoPath);
  await restore();
  return { ok: true, commit: head.ok ? head.stdout.trim() : undefined };
}

export interface DeleteBranchResult {
  ok: boolean;
  deleted: boolean;
  reason?: string;
}

/** Delete an agent branch. Safe mode uses `-d`; abandoned stories can opt into force `-D`. */
export async function deleteBranch(
  repoPath: string,
  branch: string,
  opts: { force?: boolean } = {},
): Promise<DeleteBranchResult> {
  if (!(await branchExists(repoPath, branch))) return { ok: true, deleted: false };
  const r = await git(['branch', opts.force ? '-D' : '-d', branch], repoPath);
  if (r.ok) return { ok: true, deleted: true };
  const reason = r.stderr.trim() || r.stdout.trim() || `git branch ${opts.force ? '-D' : '-d'} failed`;
  log.warn('branch delete failed', { repoPath, branch, force: opts.force === true, reason });
  return { ok: false, deleted: false, reason };
}
