import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, sanitizeWorkspaceKey } from '../core/keys';
import type { CommitGuardConfig } from '../core/projectConfig';
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

export interface BranchList {
  default_branch: string;
  branches: string[];
}

const MAX_PATCH_BYTES = 200_000;

export async function listBranches(repoPath: string, defaultBranch: string): Promise<BranchList> {
  const result = await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], repoPath);
  const branches = result.ok
    ? [...new Set(result.stdout.split('\n').map((line) => normalizeBranchListEntry(line)).filter(Boolean))].sort()
    : [];
  return { default_branch: defaultBranch, branches };
}

export async function isValidBranchName(repoPath: string, branch: string): Promise<boolean> {
  if (!branch.trim() || branch.startsWith('-')) return false;
  const result = await git(['check-ref-format', '--branch', branch], repoPath);
  return result.ok;
}

export interface EnsureBranchResult {
  ok: boolean;
  created: boolean;
  reason?: string;
}

export async function ensureBranch(
  repoPath: string,
  branch: string,
  fromBranch: string,
  opts: { create?: boolean; remote?: string } = {},
): Promise<EnsureBranchResult> {
  if (!(await isValidBranchName(repoPath, branch))) return { ok: false, created: false, reason: `invalid branch name: ${branch}` };
  if (await branchExists(repoPath, branch)) return { ok: true, created: false };
  if (opts.remote && await remoteBranchExists(repoPath, opts.remote, branch)) {
    const fetch = await git(['fetch', opts.remote, `${branch}:${branch}`], repoPath, 120_000);
    if (fetch.ok || await branchExists(repoPath, branch)) return { ok: true, created: false };
    return { ok: false, created: false, reason: fetch.stderr.trim() || fetch.stdout.trim() || `could not fetch ${opts.remote}/${branch}` };
  }
  if (!opts.create) return { ok: false, created: false, reason: `branch ${branch} not found` };
  if (!(await branchExists(repoPath, fromBranch))) {
    return { ok: false, created: false, reason: `source branch ${fromBranch} not found` };
  }
  const result = await git(['branch', branch, fromBranch], repoPath);
  if (!result.ok) return { ok: false, created: false, reason: result.stderr.trim() || result.stdout.trim() || `could not create ${branch}` };
  return { ok: true, created: true };
}

async function remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean> {
  const result = await git(['ls-remote', '--exit-code', '--heads', remote, branch], repoPath, 120_000);
  return result.ok;
}

function normalizeBranchListEntry(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length);
  if (!trimmed.startsWith('refs/remotes/') || trimmed.endsWith('/HEAD')) return '';
  const remoteBranch = trimmed.slice('refs/remotes/'.length);
  const slash = remoteBranch.indexOf('/');
  return slash === -1 ? '' : remoteBranch.slice(slash + 1);
}

export async function pushBranch(repoPath: string, remote: string, branch: string): Promise<MergeResult> {
  const result = await git(['push', '-u', remote, branch], repoPath, 120_000);
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.stderr.trim() || result.stdout.trim() || `push ${remote} ${branch} failed` };
}

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

export interface CommitResult {
  ok: boolean;
  committed: boolean;
  reason?: string;
  files: string[];
}

export interface CommitOptions {
  guard?: CommitGuardConfig;
}

/** Install or remove the opt-in pre-commit defense for a worktree. */
export async function installCommitGuardHook(worktreePath: string, guard: CommitGuardConfig): Promise<void> {
  const hookPath = await gitPath(worktreePath, 'hooks/pre-commit');
  const scriptPath = await gitPath(worktreePath, 'symphony-commit-guard.cjs');
  if (!guard.enabled) {
    removeCommitGuardHook(hookPath, scriptPath, await gitPath(worktreePath, 'SYMPHONY_COMMIT_TOKEN'));
    return;
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, guardScript(guard), { mode: 0o755 });
  fs.writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      'token="$(git rev-parse --git-path SYMPHONY_COMMIT_TOKEN)"',
      'script="$(git rev-parse --git-path symphony-commit-guard.cjs)"',
      'if [ ! -f "$token" ]; then',
      '  echo "Symphony commit guard: manual commits are disabled in this worktree; do not use git add -A or git add .; let Symphony stage explicit paths." >&2',
      '  exit 1',
      'fi',
      'rm -f "$token"',
      'node "$script"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function removeCommitGuardHook(hookPath: string, scriptPath: string, tokenPath: string): void {
  try {
    const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : '';
    if (existing.includes('Symphony commit guard')) fs.rmSync(hookPath, { force: true });
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(scriptPath, { force: true });
    fs.rmSync(tokenPath, { force: true });
  } catch {
    /* best effort */
  }
}

/** Stage + commit everything in the worktree. Returns false if there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string, opts: CommitOptions = {}): Promise<boolean> {
  const result = await commitWorktree(worktreePath, message, opts);
  if (!result.ok) throw new Error(result.reason ?? 'commit failed');
  return result.committed;
}

export async function commitWorktree(
  worktreePath: string,
  message: string,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  if (!opts.guard?.enabled) return legacyCommitAll(worktreePath, message);
  await installCommitGuardHook(worktreePath, opts.guard);

  const guard = await checkCommitGuard(worktreePath, opts.guard);
  if (!guard.ok) return { ok: false, committed: false, reason: guard.reason, files: guard.files };

  await git(['reset'], worktreePath);
  for (const chunk of chunks(guard.files, 50)) {
    const add = await git(['add', '--', ...chunk], worktreePath);
    if (!add.ok) {
      return { ok: false, committed: false, reason: add.stderr.trim() || add.stdout.trim() || 'git add failed', files: guard.files };
    }
  }

  const staged = await git(['diff', '--cached', '--name-only'], worktreePath);
  if (staged.ok && staged.stdout.trim() === '') return { ok: true, committed: false, files: [] };

  await writeCommitToken(worktreePath);
  const commit = await git(['commit', '-m', message], worktreePath);
  if (!commit.ok) {
    await removeCommitToken(worktreePath);
    return { ok: false, committed: false, reason: commit.stderr.trim() || commit.stdout.trim() || 'git commit failed', files: guard.files };
  }
  return { ok: true, committed: true, files: guard.files };
}

async function legacyCommitAll(worktreePath: string, message: string): Promise<CommitResult> {
  await git(['add', '-A'], worktreePath);
  const status = await git(['status', '--porcelain'], worktreePath);
  if (status.ok && status.stdout.trim() === '') return { ok: true, committed: false, files: [] };
  const r = await git(['commit', '-m', message], worktreePath);
  return {
    ok: r.ok,
    committed: r.ok,
    reason: r.ok ? undefined : r.stderr.trim() || r.stdout.trim() || 'git commit failed',
    files: [],
  };
}

interface GuardCheck {
  ok: boolean;
  reason?: string;
  files: string[];
}

async function checkCommitGuard(worktreePath: string, guard: CommitGuardConfig): Promise<GuardCheck> {
  const entries = await statusEntries(worktreePath);
  const files = [...new Set(entries.map((entry) => entry.path))];
  const blocked = files.filter((file) => matchesAnyGlob(file, guard.blocked_untracked_globs));
  if (blocked.length > 0) {
    return {
      ok: false,
      files,
      reason: `commit guard blocked ignored scratch files: ${blocked.join(', ')}`,
    };
  }
  if (!guard.override_limits) {
    if (guard.max_files !== undefined && files.length > guard.max_files) {
      return { ok: false, files, reason: `commit guard blocked ${files.length} files (limit ${guard.max_files})` };
    }
    if (guard.max_bytes !== undefined) {
      const bytes = totalBytes(worktreePath, files);
      if (bytes > guard.max_bytes) {
        return { ok: false, files, reason: `commit guard blocked ${bytes} bytes (limit ${guard.max_bytes})` };
      }
    }
  }
  return { ok: true, files };
}

async function statusEntries(worktreePath: string): Promise<{ status: string; path: string }[]> {
  const status = await git(['status', '--porcelain=v1', '-z'], worktreePath);
  if (!status.ok || !status.stdout) return [];
  const records = status.stdout.split('\0').filter(Boolean);
  const entries: { status: string; path: string }[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    const statusCode = record.slice(0, 2);
    let file = record.slice(3);
    if (statusCode.includes('R') || statusCode.includes('C')) {
      i += 1;
      file = records[i] ?? file;
    }
    if (file) entries.push({ status: statusCode, path: file });
  }
  return entries;
}

async function gitPath(worktreePath: string, gitRelativePath: string): Promise<string> {
  const result = await git(['rev-parse', '--git-path', gitRelativePath], worktreePath);
  if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not resolve git path ${gitRelativePath}`);
  return path.resolve(worktreePath, result.stdout.trim());
}

async function writeCommitToken(worktreePath: string): Promise<void> {
  fs.writeFileSync(await gitPath(worktreePath, 'SYMPHONY_COMMIT_TOKEN'), String(Date.now()));
}

async function removeCommitToken(worktreePath: string): Promise<void> {
  try {
    fs.rmSync(await gitPath(worktreePath, 'SYMPHONY_COMMIT_TOKEN'), { force: true });
  } catch {
    /* best effort */
  }
}

function totalBytes(worktreePath: string, files: string[]): number {
  let total = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(worktreePath, file));
      if (stat.isFile()) total += stat.size;
    } catch {
      /* deleted file */
    }
  }
  return total;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegex(glob).test(file));
}

function globToRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    const next = glob[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function guardScript(guard: CommitGuardConfig): string {
  return `const { execFileSync } = require('node:child_process');
const guard = ${JSON.stringify(guard)};
const output = (args) => execFileSync('git', args, { encoding: 'utf8' });
const files = output(['status', '--porcelain=v1', '-z']).split('\\0').filter(Boolean).map((record, index, all) => {
  const status = record.slice(0, 2);
  if (status.includes('R') || status.includes('C')) return all[index + 1] || record.slice(3);
  return record.slice(3);
}).filter(Boolean);
const globToRegex = (glob) => {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === '*' && next === '*') { out += '.*'; i += 1; }
    else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[|\\\\{}()[\\]^$+?.]/g, '\\\\$&');
  }
  return new RegExp(out + '$');
};
const blocked = files.filter((file) => guard.blocked_untracked_globs.some((glob) => globToRegex(glob).test(file)));
if (blocked.length > 0) {
  console.error('Symphony commit guard blocked ignored scratch files: ' + blocked.join(', '));
  process.exit(1);
}
`;
}

export interface MergeResult {
  ok: boolean;
  reason?: string;
  commit?: string;
  resolved_conflicts?: boolean;
  conflicted_files?: string[];
  report?: string;
}

export interface MergeConflictResolverInput {
  checkoutPath: string;
  base: string;
  branch: string;
  message: string;
  conflictedFiles: string[];
  mergeOutput: string;
}

export interface MergeConflictResolverResult {
  ok: boolean;
  reason?: string;
  report?: string;
}

export type MergeConflictResolver = (
  input: MergeConflictResolverInput,
) => Promise<MergeConflictResolverResult>;

export type MergeVerifier = (checkoutPath: string) => Promise<{ ok: boolean; reason?: string }>;

export interface MergeAgentBranchOptions {
  resolver?: MergeConflictResolver;
  verify?: MergeVerifier;
}

/**
 * Merge an agent branch into its base for the review-approval action. The integration is built
 * in a temporary branch + worktree first, so conflicts can be resolved and verified before the
 * target branch moves. The user's current checkout is touched only for the final fast-forward
 * when that checkout is the target branch; otherwise we update the target ref directly.
 */
export async function mergeAgentBranch(
  repoPath: string,
  base: string,
  branch: string,
  message: string,
  opts: MergeAgentBranchOptions = {},
): Promise<MergeResult> {
  if (!(await isGitRepo(repoPath))) return { ok: false, reason: 'project repo is not a git repository' };
  if (!(await branchExists(repoPath, branch))) return { ok: false, reason: `branch ${branch} not found` };
  if (!(await branchExists(repoPath, base))) return { ok: false, reason: `base branch ${base} not found` };

  const original = await currentBranch(repoPath); // null when detached
  const baseStart = await git(['rev-parse', base], repoPath);
  if (!baseStart.ok) return { ok: false, reason: `could not inspect ${base}: ${baseStart.stderr.trim() || baseStart.stdout.trim()}` };

  const tempBranch = `symphony/integration/${sanitizeWorkspaceKey(branch).replaceAll('/', '-')}-${newId()}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-merge-'));
  let keepTempBranch = false;
  try {
    const create = await git(['branch', tempBranch, base], repoPath);
    if (!create.ok) return { ok: false, reason: `could not create integration branch: ${create.stderr.trim() || create.stdout.trim()}` };
    const add = await git(['worktree', 'add', tempRoot, tempBranch], repoPath);
    if (!add.ok) return { ok: false, reason: `could not create integration worktree: ${add.stderr.trim() || add.stdout.trim()}` };
    // A fresh worktree omits ignored dependency trees; seed them so post-merge verification
    // commands (e.g. `npm test`) can run here exactly as they do in the agent's own worktree.
    seedDependencyArtifacts(repoPath, tempRoot);

    const integrated = await mergeInCheckout(tempRoot, base, branch, message, opts);
    if (!integrated.ok) return integrated;

    if (opts.verify) {
      const verification = await opts.verify(tempRoot);
      if (!verification.ok) {
        return {
          ok: false,
          reason: verification.reason ?? 'post-merge verification failed',
          resolved_conflicts: integrated.resolved_conflicts,
          conflicted_files: integrated.conflicted_files,
          report: integrated.report,
        };
      }
    }

    const apply = await applyIntegratedBranch(repoPath, base, tempBranch, baseStart.stdout.trim(), original);
    if (!apply.ok) {
      keepTempBranch = true;
      return {
        ok: false,
        reason: `${apply.reason} — resolved integration is available on ${tempBranch}`,
        resolved_conflicts: integrated.resolved_conflicts,
        conflicted_files: integrated.conflicted_files,
        report: integrated.report,
      };
    }
    return {
      ok: true,
      commit: apply.commit,
      resolved_conflicts: integrated.resolved_conflicts,
      conflicted_files: integrated.conflicted_files,
      report: integrated.report,
    };
  } finally {
    await removeWorktree(repoPath, tempRoot);
    if (!keepTempBranch) await git(['branch', '-D', tempBranch], repoPath);
  }
}

async function mergeInCheckout(
  checkoutPath: string,
  base: string,
  branch: string,
  message: string,
  opts: MergeAgentBranchOptions,
): Promise<MergeResult> {
  const merge = await git(['merge', '--no-ff', branch, '-m', message], checkoutPath);
  if (merge.ok) return { ok: true };

  const mergeOutput = merge.stderr.trim() || merge.stdout.trim();
  const conflictedFiles = await listConflictedFiles(checkoutPath);
  if (conflictedFiles.length === 0 || !opts.resolver) {
    await git(['merge', '--abort'], checkoutPath);
    return { ok: false, reason: `merge failed — resolve manually: ${mergeOutput}` };
  }

  const resolved = await opts.resolver({
    checkoutPath,
    base,
    branch,
    message,
    conflictedFiles,
    mergeOutput,
  });
  if (!resolved.ok) {
    await git(['merge', '--abort'], checkoutPath);
    return {
      ok: false,
      reason: resolved.reason ?? 'conflict resolver failed',
      conflicted_files: conflictedFiles,
      report: resolved.report,
    };
  }

  const markerFiles = filesWithConflictMarkers(checkoutPath, conflictedFiles);
  if (markerFiles.length > 0) {
    await git(['merge', '--abort'], checkoutPath);
    return {
      ok: false,
      reason: `conflict resolver left conflict markers in: ${markerFiles.join(', ')}`,
      conflicted_files: markerFiles,
      report: resolved.report,
    };
  }

  // Stage ONLY the conflicted paths (add/modify/delete) — never `git add -A`, which would sweep
  // any stray file the resolver agent left in the worktree into the approved merge commit.
  const add = await git(['add', '-A', '--', ...conflictedFiles], checkoutPath);
  if (!add.ok) {
    await git(['merge', '--abort'], checkoutPath);
    return { ok: false, reason: `could not stage resolved conflicts: ${add.stderr.trim() || add.stdout.trim()}`, conflicted_files: conflictedFiles, report: resolved.report };
  }
  const remaining = await listConflictedFiles(checkoutPath);
  if (remaining.length > 0) {
    await git(['merge', '--abort'], checkoutPath);
    return {
      ok: false,
      reason: `conflict resolver left unresolved files: ${remaining.join(', ')}`,
      conflicted_files: remaining,
      report: resolved.report,
    };
  }
  const commit = await git(['commit', '--no-edit'], checkoutPath);
  if (!commit.ok) {
    await git(['merge', '--abort'], checkoutPath);
    return { ok: false, reason: `could not commit resolved merge: ${commit.stderr.trim() || commit.stdout.trim()}`, conflicted_files: conflictedFiles, report: resolved.report };
  }
  return { ok: true, resolved_conflicts: true, conflicted_files: conflictedFiles, report: resolved.report };
}

async function applyIntegratedBranch(
  repoPath: string,
  base: string,
  integrationBranch: string,
  expectedBaseSha: string,
  originalBranch: string | null,
): Promise<MergeResult> {
  const currentBase = await git(['rev-parse', base], repoPath);
  if (!currentBase.ok) return { ok: false, reason: `could not inspect ${base}: ${currentBase.stderr.trim() || currentBase.stdout.trim()}` };
  if (currentBase.stdout.trim() !== expectedBaseSha) {
    return { ok: false, reason: `${base} moved while integration was running — retry approval` };
  }

  const apply = originalBranch === base
    ? await git(['merge', '--ff-only', integrationBranch], repoPath)
    : await git(['branch', '-f', base, integrationBranch], repoPath);
  if (!apply.ok) {
    return { ok: false, reason: `could not apply integrated result to ${base}: ${apply.stderr.trim() || apply.stdout.trim()}` };
  }
  const head = await git(['rev-parse', '--short', base], repoPath);
  return { ok: true, commit: head.ok ? head.stdout.trim() : undefined };
}

async function listConflictedFiles(worktreePath: string): Promise<string[]> {
  const result = await git(['diff', '--name-only', '--diff-filter=U'], worktreePath);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function filesWithConflictMarkers(worktreePath: string, files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const full = path.join(worktreePath, file);
    try {
      if (!fs.statSync(full).isFile()) continue;
      if (/^(<<<<<<<|=======|>>>>>>>)/m.test(fs.readFileSync(full, 'utf8'))) out.push(file);
    } catch {
      /* deleted or binary file */
    }
  }
  return out;
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
