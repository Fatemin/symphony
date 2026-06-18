import type {
  Issue,
  IssuePlanContext,
  IssueTask,
  PlanKeyFile,
  Project,
  ProjectNote,
  RunPhase,
} from '../../shared/types';
import type { NewTask } from '../repo/tasks';

export interface PromptContext {
  project: Project;
  issue: Issue;
  attempt: number;
  /** Why the previous attempt failed (retries only) — spares the agent re-deriving it. */
  lastFailure?: { phase: RunPhase; error: string } | null;
  /** Recent learnings from completed issues in this project, newest first. */
  notes?: ProjectNote[];
}

/** Append optional per-repo policy guidance (from WORKFLOW.md) to a phase prompt. */
function withPolicy(prompt: string, extra?: string): string {
  return extra?.trim() ? `${prompt}\n\n## Repository policy\n${extra.trim()}` : prompt;
}

const PRIORITY_LABEL = ['none', 'urgent', 'high', 'medium', 'low'];

/** Shared header: who we are + the issue + optional project context. */
function issueBrief(ctx: PromptContext): string {
  const { issue, project } = ctx;
  const lines = [
    `# Issue ${issue.key}: ${issue.title}`,
    ``,
    `- Type: ${issue.type}`,
    `- Priority: ${PRIORITY_LABEL[issue.priority] ?? 'none'}`,
    issue.labels.length ? `- Labels: ${issue.labels.join(', ')}` : null,
    ``,
    `## Description`,
    issue.description?.trim() || '_(none provided)_',
  ];
  if (issue.acceptance_criteria?.trim()) {
    lines.push(``, `## Acceptance criteria`, issue.acceptance_criteria.trim());
  }
  if (project.context?.trim()) {
    lines.push(``, `## Project context`, project.context.trim());
  }
  const notes = (ctx.notes ?? []).slice(0, 5);
  if (notes.length) {
    lines.push(``, `## Learnings from recently completed issues in this project`);
    for (const n of notes) lines.push(`- ${n.content.slice(0, 500)}`);
  }
  lines.push(
    ``,
    `> The repository's own CLAUDE.md / AGENTS.md (if present) is authoritative for conventions;` +
      ` follow it. You are working in an isolated git worktree on branch \`${issue.branch_name ?? '(agent branch)'}\`.`,
    `> You are running unattended — no human can answer questions mid-run, so never use` +
      ` interactive tools (e.g. AskUserQuestion). When requirements are ambiguous, pick the most` +
      ` reasonable interpretation, state the assumption explicitly in your final output, and keep going.`,
  );
  if (ctx.attempt > 1) {
    const f = ctx.lastFailure;
    lines.push(
      ``,
      f
        ? `> This is retry attempt ${ctx.attempt}. The previous attempt failed in the **${f.phase}** phase:` +
          ` ${f.error.replace(/\s+/g, ' ').slice(0, 500)}\n` +
          `> Address that failure first — re-examine the working tree and prior changes before proceeding.`
        : `> This is retry attempt ${ctx.attempt}. A previous attempt failed — re-examine the working tree and prior changes before proceeding.`,
    );
  }
  return lines.filter((l) => l !== null).join('\n');
}

// ── plan phase ────────────────────────────────────────────────────────────

const PLAN_FENCE = 'symphony-plan';

export function buildPlanPrompt(ctx: PromptContext, extra?: string): string {
  return withPolicy(
    `${issueBrief(ctx)}

---

You are the **tech lead**. Read the relevant parts of the repository, then produce a concrete
implementation plan for this issue — a short ordered checklist of tasks an engineer will execute.

Do NOT write any code in this step. Keep tasks small and verifiable.
Preserve the useful exploration context for the implementer: do not make them rediscover the same
files, symbols, commands, or constraints. Avoid re-reading files you already inspected; for broad
discovery, use an Explore subagent early and then do targeted reads/searches.

End your response with EXACTLY ONE fenced code block tagged \`${PLAN_FENCE}\` containing JSON:

\`\`\`${PLAN_FENCE}
{
  "tasks": [
    { "role": "impl", "title": "short imperative title", "intent": "one line: what & why" }
  ],
  "key_files": [
    { "path": "relative/path.ext", "purpose": "one sentence: why this file matters" }
  ],
  "context": "concise implementation context: symbols, routes, data flow, commands, gotchas",
  "notes": "optional risks or sequencing notes"
}
\`\`\`

\`role\` is one of: impl, qa, frontend, backend, docs, other.`,
    extra,
  );
}

export interface ParsedPlan {
  tasks: NewTask[];
  key_files: PlanKeyFile[];
  context?: string;
  notes?: string;
}

/** Extract the plan JSON from the agent's final text. Tolerant of missing/loose fences. */
export function parsePlan(text: string): ParsedPlan {
  const json = extractFenced(text, PLAN_FENCE) ?? extractFenced(text, 'json') ?? extractFirstObject(text);
  if (!json) return { tasks: [], key_files: [] };
  try {
    const obj = JSON.parse(json) as { tasks?: unknown; notes?: unknown };
    const tasks: NewTask[] = Array.isArray(obj.tasks)
      ? obj.tasks
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t) => ({
            role: normalizeRole(t.role),
            title: String(t.title ?? '').trim() || 'Untitled task',
            intent: t.intent != null ? String(t.intent) : null,
          }))
      : [];
    return {
      tasks,
      key_files: normalizeKeyFiles((obj as { key_files?: unknown }).key_files),
      context: typeof (obj as { context?: unknown }).context === 'string'
        ? (obj as { context: string }).context.trim() || undefined
        : undefined,
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    };
  } catch {
    return { tasks: [], key_files: [] };
  }
}

function normalizeRole(role: unknown): NewTask['role'] {
  const allowed = ['impl', 'qa', 'frontend', 'backend', 'docs', 'other'] as const;
  const r = String(role ?? 'impl').toLowerCase();
  return (allowed as readonly string[]).includes(r) ? (r as NewTask['role']) : 'impl';
}

function normalizeKeyFiles(value: unknown): PlanKeyFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      path: String(f.path ?? '').trim(),
      purpose: String(f.purpose ?? f.role ?? f.reason ?? '').trim(),
    }))
    .filter((f) => f.path.length > 0)
    .slice(0, 20);
}

// ── implement phase ─────────────────────────────────────────────────────────

export function buildImplementPrompt(
  ctx: PromptContext,
  tasks: IssueTask[],
  planContext?: IssuePlanContext | null,
  extra?: string,
): string {
  const checklist = tasks.length
    ? tasks.map((t) => `- [ ] (${t.role}) ${t.title}${t.intent ? ` — ${t.intent}` : ''}`).join('\n')
    : '_(no pre-planned tasks — decide the steps yourself)_';
  const exploration = renderPlanContext(planContext);

  return withPolicy(
    `${issueBrief(ctx)}

---

You are the **implementing engineer**. Implement this issue end to end in the current worktree.

Planned checklist:
${checklist}
${exploration}

Guidelines:
- Start from the planning context above; avoid repeating broad exploration unless it is stale or
  incomplete. Prefer targeted verification reads over re-reading every file the planner already mapped.
- Make the smallest correct change that satisfies the acceptance criteria.
- Match the existing code style and patterns in this repository.
- If the project has tests or a build, run them and fix what you broke.
- If you discover reusable environment details (test commands, package manager quirks, venv paths,
  install/cache notes), include a short "Reusable environment notes:" sentence in your final report.
- You do NOT need to create a git commit — the orchestrator commits your changes after this step.

When finished, end with a one-paragraph summary of what you changed and how you verified it.`,
    extra,
  );
}

function renderPlanContext(planContext?: IssuePlanContext | null): string {
  if (!planContext) return '';
  const lines: string[] = [];
  if (planContext.key_files.length) {
    lines.push('', 'Planning context - key files:');
    for (const f of planContext.key_files) {
      lines.push(`- ${f.path}${f.purpose ? `: ${f.purpose}` : ''}`);
    }
  }
  if (planContext.context?.trim()) {
    lines.push('', 'Planning context - implementation notes:', planContext.context.trim());
  }
  if (planContext.notes?.trim()) {
    lines.push('', 'Planning context - risks or sequencing:', planContext.notes.trim());
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
}

// ── qa phase ────────────────────────────────────────────────────────────────

export function buildQaPrompt(
  ctx: PromptContext,
  implementReport: string | null,
  extra?: string,
): string {
  const reportSection = implementReport?.trim()
    ? `
The implementing engineer reported:

<implementation-report>
${implementReport.trim().slice(-2000)}
</implementation-report>
`
    : '';
  return withPolicy(
    `${issueBrief(ctx)}

---

You are an independent **QA engineer**. The implementation for this issue has been committed to the
current worktree. Your job is to verify it against the acceptance criteria — do not implement new
features, but you MAY make trivial fixes if something is clearly broken.
${reportSection}
Steps:
1. Review the diff on this branch against its base.
2. Build the project and run its tests / linters if they exist.
3. Check each acceptance criterion explicitly.

End your response with EXACTLY ONE line in this format:

QA_RESULT: PASS — <short reason>
   …or…
QA_RESULT: FAIL — <what is missing or broken>`,
    extra,
  );
}

export interface QaVerdict {
  pass: boolean;
  reason: string;
}

/** Parse the QA verdict from the agent's final text. Absent/ambiguous verdict ⇒ FAIL. */
export function parseQa(text: string): QaVerdict {
  // The prompt demands the verdict as the LAST line — take the last match, so reasoning or
  // quoted repo policy that mentions QA_RESULT earlier cannot shadow the real verdict.
  const matches = [...text.matchAll(/QA_RESULT:\s*(PASS|FAIL)\s*[—\-:：]*\s*(.*)/gi)];
  const match = matches[matches.length - 1];
  if (!match) return { pass: false, reason: 'no QA_RESULT verdict found in agent output' };
  return { pass: match[1]!.toUpperCase() === 'PASS', reason: (match[2] ?? '').trim() };
}

// ── fenced-block helpers ────────────────────────────────────────────────────

function extractFenced(text: string, tag: string): string | null {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = text.match(re);
  return m ? m[1]!.trim() : null;
}

function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
