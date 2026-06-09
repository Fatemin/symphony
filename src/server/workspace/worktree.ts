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

  log.info('worktree created', { path: spec.worktreePath, branch: spec.branch });
  return { path: spec.worktreePath, created: true };
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
 * construction: refuses if the main working tree is dirty, aborts cleanly on conflict, and
 * restores the repo's originally checked-out branch afterward so approving doesn't move the
 * user's HEAD out from under them.
 */
export async function mergeAgentBranch(
  repoPath: string,
  base: string,
  branch: string,
  message: string,
): Promise<MergeResult> {
  if (!(await isGitRepo(repoPath))) return { ok: false, reason: 'project repo is not a git repository' };
  if (!(await branchExists(repoPath, branch))) return { ok: false, reason: `branch ${branch} not found` };

  const status = await git(['status', '--porcelain'], repoPath);
  if (status.ok && status.stdout.trim() !== '') {
    return { ok: false, reason: 'main repo has uncommitted changes — commit/stash them or merge manually' };
  }

  const original = await currentBranch(repoPath); // null when detached
  if (original !== base) {
    const co = await git(['checkout', base], repoPath);
    if (!co.ok) return { ok: false, reason: `could not switch to ${base}: ${co.stderr.trim() || co.stdout.trim()}` };
  }

  const restore = async () => {
    if (original && original !== base) await git(['checkout', original], repoPath);
  };

  const merge = await git(['merge', '--no-ff', branch, '-m', message], repoPath);
  if (!merge.ok) {
    await git(['merge', '--abort'], repoPath);
    await restore();
    return { ok: false, reason: `merge conflict or failure — resolve manually: ${merge.stderr.trim() || merge.stdout.trim()}` };
  }

  const head = await git(['rev-parse', '--short', base], repoPath);
  await restore();
  return { ok: true, commit: head.ok ? head.stdout.trim() : undefined };
}

/** Delete a branch (safe `-d`; only succeeds if already merged). Best-effort. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(['branch', '-d', branch], repoPath);
}
