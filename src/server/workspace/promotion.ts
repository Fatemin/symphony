import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Issue, Project } from '../../shared/types';
import type { ProjectConfig } from '../core/projectConfig';
import { git } from './git';
import { runVerificationCommands, type VerificationResult } from './verification';

export interface PullRequestPromotionResult {
  ok: boolean;
  reason?: string;
  pr_url?: string;
  pushed?: boolean;
  merged?: boolean;
  verification?: VerificationResult;
}

export interface PullRequestPromotionOptions {
  project: Project;
  issue: Issue;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  config: ProjectConfig;
}

export async function promoteViaPullRequest(
  opts: PullRequestPromotionOptions,
): Promise<PullRequestPromotionResult> {
  const remote = opts.config.promotion.remote;
  const clean = await requireCleanWorktree(opts.worktreePath);
  if (!clean.ok) return clean;

  const fetch = await git(['fetch', remote, opts.baseBranch], opts.worktreePath, 120_000);
  if (!fetch.ok) return { ok: false, reason: `fetch ${remote}/${opts.baseBranch} failed: ${message(fetch)}` };

  const rebase = await git(['rebase', `${remote}/${opts.baseBranch}`], opts.worktreePath, 120_000);
  if (!rebase.ok) {
    await git(['rebase', '--abort'], opts.worktreePath);
    return { ok: false, reason: `rebase onto ${remote}/${opts.baseBranch} failed: ${message(rebase)}` };
  }

  let verification: VerificationResult;
  try {
    verification = await runVerificationCommands(opts.worktreePath, opts.config.verification.commands);
  } catch (e) {
    return { ok: false, reason: `verification setup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!verification.ok) return { ok: false, reason: verification.summary, verification };

  const push = await git(['push', '-u', remote, opts.branch], opts.worktreePath, 120_000);
  if (!push.ok) return { ok: false, reason: `push ${remote} ${opts.branch} failed: ${message(push)}`, verification };

  const pr = await createOrFindPullRequest(opts, verification);
  if (!pr.ok) return { ok: false, reason: pr.reason, pushed: true, verification };

  if (!opts.config.promotion.auto_merge) {
    return { ok: true, pr_url: pr.url, pushed: true, merged: false, verification };
  }

  const merge = await waitAndMergePr(opts.worktreePath, pr.url, opts.config);
  return {
    ok: true,
    pr_url: pr.url,
    pushed: true,
    merged: merge.merged,
    reason: merge.reason,
    verification,
  };
}

async function requireCleanWorktree(worktreePath: string): Promise<PullRequestPromotionResult> {
  const status = await git(['status', '--porcelain'], worktreePath);
  if (!status.ok) return { ok: false, reason: `could not inspect worktree status: ${message(status)}` };
  if (status.stdout.trim()) return { ok: false, reason: 'worktree has uncommitted changes — run the issue again or commit them before promotion' };
  return { ok: true };
}

async function createOrFindPullRequest(
  opts: PullRequestPromotionOptions,
  verification: VerificationResult,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const title = `${opts.issue.key}: ${opts.issue.title}`;
  const body = pullRequestBody(opts.project, opts.issue, verification, opts.worktreePath);
  const created = await gh(
    ['pr', 'create', '--base', opts.baseBranch, '--head', opts.branch, '--title', title, '--body', body],
    opts.worktreePath,
  );
  if (created.ok) return { ok: true, url: lastLine(created.stdout) };

  const existing = await gh(['pr', 'view', opts.branch, '--json', 'url', '--jq', '.url'], opts.worktreePath);
  if (existing.ok && existing.stdout.trim()) return { ok: true, url: lastLine(existing.stdout) };
  return { ok: false, reason: `gh pr create failed: ${created.stderr.trim() || created.stdout.trim() || created.error || 'unknown error'}` };
}

function pullRequestBody(project: Project, issue: Issue, verification: VerificationResult, worktreePath: string): string {
  const lines = [
    `Issue: ${issue.key}`,
    `Project: ${project.name}`,
    '',
    issue.description?.trim() ? `## Description\n${issue.description.trim()}\n` : '',
    issue.acceptance_criteria?.trim() ? `## Acceptance Criteria\n${issue.acceptance_criteria.trim()}\n` : '',
    '## Verification',
    ...verification.commands.map((command) => `- \`${command.command}\` in \`${relativeCwd(command.cwd, worktreePath)}\`: ${command.ok ? 'passed' : 'failed'}`),
  ].filter(Boolean);
  return lines.join('\n');
}

async function waitAndMergePr(
  cwd: string,
  prUrl: string,
  config: ProjectConfig,
): Promise<{ merged: boolean; reason?: string }> {
  const deadline = Date.now() + config.promotion.check_timeout_ms;
  while (Date.now() <= deadline) {
    const view = await gh(['pr', 'view', prUrl, '--json', 'reviewDecision,mergeStateStatus,statusCheckRollup'], cwd);
    if (!view.ok) return { merged: false, reason: `could not inspect PR: ${view.stderr.trim() || view.stdout.trim() || view.error}` };
    const state = parsePrState(view.stdout);
    if (state.ready) {
      const merge = await gh(['pr', 'merge', prUrl, '--merge'], cwd);
      return merge.ok
        ? { merged: true }
        : { merged: false, reason: `PR was ready but merge failed: ${merge.stderr.trim() || merge.stdout.trim() || merge.error}` };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(config.promotion.check_poll_interval_ms, 1000)));
  }
  return { merged: false, reason: 'PR left open — checks or reviews were not satisfied before the auto-merge timeout' };
}

function parsePrState(raw: string): { ready: boolean } {
  try {
    const json = JSON.parse(raw) as {
      reviewDecision?: string;
      mergeStateStatus?: string;
      statusCheckRollup?: { conclusion?: string; status?: string }[];
    };
    const checks = json.statusCheckRollup ?? [];
    const checksReady = checks.every((check) => {
      const conclusion = check.conclusion ?? check.status;
      return ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED'].includes(String(conclusion).toUpperCase());
    });
    const reviewReady = !['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(String(json.reviewDecision ?? '').toUpperCase());
    const mergeReady = !['DIRTY', 'BLOCKED', 'BEHIND'].includes(String(json.mergeStateStatus ?? '').toUpperCase());
    return { ready: checksReady && reviewReady && mergeReady };
  } catch {
    return { ready: false };
  }
}

function gh(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout),
        stderr: String(stderr),
        error: err instanceof Error ? err.message : undefined,
      });
    });
  });
}

function lastLine(value: string): string {
  return value.trim().split('\n').filter(Boolean).at(-1) ?? value.trim();
}

function relativeCwd(cwd: string, worktreePath: string): string {
  const relative = path.relative(worktreePath, cwd);
  if (!relative) return '.';
  return relative.startsWith('..') || path.isAbsolute(relative) ? cwd : relative;
}

function message(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim();
}
