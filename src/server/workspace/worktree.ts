import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWorkspaceKey } from '../core/keys';
import { log } from '../observability/logger';
import { branchExists, git, gitOrThrow, isGitRepo } from './git';

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

/** Stage + commit everything in the worktree. Returns false if there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await git(['add', '-A'], worktreePath);
  const status = await git(['status', '--porcelain'], worktreePath);
  if (status.ok && status.stdout.trim() === '') return false;
  const r = await git(['commit', '-m', message], worktreePath);
  return r.ok;
}
