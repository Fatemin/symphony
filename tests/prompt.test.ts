import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanPrompt,
  buildImplementPrompt,
  buildQaPrompt,
  buildMergePrompt,
  buildDeliveryPrompt,
  parsePlan,
} from '../src/server/core/prompt';
import type { Issue, IssueTask, Project } from '../src/shared/types';

// prompt.ts is a pure prompt-assembly module (no DB/env at import), so these tests call the
// builders directly with hand-built domain objects — no setupEnv()/fake runner needed. They guard
// the professional-team quality bar (SYM-24): each rewritten prompt must keep its phase-detection
// anchor (fakeRunner.ts depends on it) AND carry its key new instructions.

const project: Project = {
  id: 'p1',
  key: 'PR',
  name: 'Prompt Project',
  description: null,
  color: '#fff',
  repo_path: '/tmp/repo',
  default_branch: 'main',
  context: null,
  model: null,
  agent: null,
  preview_command: null,
  config: null,
  created_at: '2026-06-19T00:00:00Z',
};

const issue: Issue = {
  id: 'i1',
  project_id: 'p1',
  parent_id: null,
  key: 'PR-1',
  type: 'feature',
  title: 'Build a thing',
  description: 'Do the work.',
  acceptance_criteria: '- it works',
  labels: [],
  priority: 2,
  status: 'in_progress',
  mode: 'auto',
  require_review: true,
  base_branch: 'main',
  branch_name: 'agent/pr-1',
  worktree_path: null,
  round: 1,
  merge_conflict: null,
  created_at: '2026-06-19T00:00:00Z',
  updated_at: '2026-06-19T00:00:00Z',
};

const ctx = { project, issue, attempt: 1 };

test('plan prompt keeps the tech-lead anchor and the professional-delivery bar', () => {
  const p = buildPlanPrompt(ctx);
  // Phase-detection: falls through to "plan" in fakeRunner, but the framing anchor stays.
  assert.match(p, /\*\*tech lead\*\*/);
  assert.match(p, /```symphony-plan/);
  // Non-functional + UX + docs + verification + delivery expectations are all surfaced.
  assert.match(p, /Non-functional requirements/);
  assert.match(p, /User experience/);
  assert.match(p, /loading, empty, error, success, disabled/);
  assert.match(p, /Documentation/);
  assert.match(p, /Verification/);
  assert.match(p, /role `delivery`/);
  // The role enum advertises delivery so the planner may emit it.
  assert.match(p, /impl, qa, frontend, backend, docs, delivery, other/);
});

test('implement prompt keeps the engineer anchor and the doc-update mandate', () => {
  const p = buildImplementPrompt(ctx, []);
  assert.match(p, /\*\*implementing engineer\*\*/);
  // The issue's core demand: docs MUST be updated as part of the work, not deferred.
  assert.match(p, /Keep documentation current/);
  assert.match(p, /Treat a\s+missing doc update as incomplete work/);
  // Frontend completeness/accessibility and the delivery-role handoff are spelled out.
  assert.match(p, /complete loading\/empty\/error\/success\/disabled states/);
  assert.match(p, /accessible semantics and focus behavior/);
  assert.match(p, /`delivery`-role checklist item/);
  // The reusable-environment-notes convention is preserved.
  assert.match(p, /Reusable environment notes:/);
});

test('implement prompt renders a delivery-role checklist item verbatim', () => {
  const tasks: IssueTask[] = [
    {
      id: 't1',
      issue_id: 'i1',
      seq: 1,
      role: 'delivery',
      title: 'Write the handoff summary',
      intent: 'summarize what shipped',
      status: 'todo',
      created_at: '2026-06-19T00:00:00Z',
    },
  ];
  const p = buildImplementPrompt(ctx, tasks);
  assert.match(p, /- \[ \] \(delivery\) Write the handoff summary/);
});

test('qa prompt keeps the verdict contract and verifies criteria + docs', () => {
  const p = buildQaPrompt(ctx, 'implementation report');
  assert.match(p, /independent \*\*QA engineer\*\*/);
  // The PASS|FAIL last-line contract (parseQa) must remain.
  assert.match(p, /QA_RESULT: PASS/);
  assert.match(p, /QA_RESULT: FAIL/);
  // Per-criterion verification, non-functional/regression checks, and a docs-currency gate.
  assert.match(p, /Check each acceptance criterion explicitly/);
  assert.match(p, /watch for regressions/);
  assert.match(p, /documentation was updated to match the new behavior/);
});

test('merge prompt keeps the release-engineer anchor and verdict contract', () => {
  const p = buildMergePrompt(ctx, { remote: 'origin', branch: 'agent/pr-1', baseBranch: 'main' });
  assert.match(p, /\*\*release engineer\*\*/);
  assert.match(p, /MERGE_RESULT: PASS/);
  assert.match(p, /MERGE_RESULT: FAIL/);
});

test('delivery prompt keeps the lead anchor and matches the requester language (SYM-33)', () => {
  const p = buildDeliveryPrompt(ctx, 'implementation report');
  // Phase-detection anchor fakeRunner depends on must stay verbatim.
  assert.match(p, /\*\*delivery lead\*\*/);
  // The summary must follow the requester's issue language, not the English scaffolding.
  assert.match(p, /SAME LANGUAGE the requester used in the issue title/);
  // \s+ tolerates the prompt's hard line wraps (e.g. "IGNORE the\nlanguage of …").
  assert.match(p, /IGNORE the\s+language of the surrounding English tooling text/);
  // Headings are translated into that language while keeping the four-section structure.
  assert.match(p, /Translate the four section HEADINGS below into that language/);
  // The four canonical headings (and the report passthrough) survive the edit.
  assert.match(p, /## What's new/);
  assert.match(p, /## Docs updated/);
});

test('issueBrief renders an Attachments section without disturbing the role anchors (SYM-35)', () => {
  const withAtt = {
    ...ctx,
    attachments: [{ filename: 'mock.png', mime: 'image/png', path: '/data/attachments/x/mock.png' }],
  };
  const plan = buildPlanPrompt(withAtt);
  const impl = buildImplementPrompt(withAtt, []);
  const qa = buildQaPrompt(withAtt, null);
  for (const p of [plan, impl, qa]) {
    assert.match(p, /## Attachments/);
    assert.ok(p.includes('mock.png (image/png): /data/attachments/x/mock.png'), 'lists file + absolute path');
  }
  // The phase-detection role substrings fakeRunner keys on must still be present after the section.
  assert.match(plan, /\*\*tech lead\*\*/);
  assert.match(impl, /\*\*implementing engineer\*\*/);
  assert.match(qa, /independent \*\*QA engineer\*\*/);
  // No attachments ⇒ no section (backward compatible).
  assert.ok(!buildImplementPrompt(ctx, []).includes('## Attachments'));
});

test('a delivery role round-trips through parsePlan without coercion to impl', () => {
  const text =
    '```symphony-plan\n' +
    JSON.stringify({
      tasks: [
        { role: 'delivery', title: 'Handoff', intent: 'summary' },
        { role: 'impl', title: 'Build', intent: 'do it' },
      ],
      key_files: [],
    }) +
    '\n```';
  const parsed = parsePlan(text);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0]!.role, 'delivery', 'delivery must survive normalizeRole');
  assert.equal(parsed.tasks[1]!.role, 'impl');
  // An unknown role still falls back to impl (the allow-list guard is intact).
  const unknown = parsePlan(
    '```symphony-plan\n' + JSON.stringify({ tasks: [{ role: 'wizard', title: 'X' }], key_files: [] }) + '\n```',
  );
  assert.equal(unknown.tasks[0]!.role, 'impl');
});
