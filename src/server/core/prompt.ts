import type { Issue, IssueTask, Project } from '../../shared/types';
import type { NewTask } from '../repo/tasks';

export interface PromptContext {
  project: Project;
  issue: Issue;
  attempt: number;
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
  lines.push(
    ``,
    `> The repository's own CLAUDE.md / AGENTS.md (if present) is authoritative for conventions;` +
      ` follow it. You are working in an isolated git worktree on branch \`${issue.branch_name ?? '(agent branch)'}\`.`,
  );
  if (ctx.attempt > 1) {
    lines.push(
      ``,
      `> This is retry attempt ${ctx.attempt}. A previous attempt failed — re-examine the working tree and prior changes before proceeding.`,
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

End your response with EXACTLY ONE fenced code block tagged \`${PLAN_FENCE}\` containing JSON:

\`\`\`${PLAN_FENCE}
{
  "tasks": [
    { "role": "impl", "title": "short imperative title", "intent": "one line: what & why" }
  ],
  "notes": "optional risks or sequencing notes"
}
\`\`\`

\`role\` is one of: impl, qa, frontend, backend, docs, other.`,
    extra,
  );
}

export interface ParsedPlan {
  tasks: NewTask[];
  notes?: string;
}

/** Extract the plan JSON from the agent's final text. Tolerant of missing/loose fences. */
export function parsePlan(text: string): ParsedPlan {
  const json = extractFenced(text, PLAN_FENCE) ?? extractFenced(text, 'json') ?? extractFirstObject(text);
  if (!json) return { tasks: [] };
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
    return { tasks, notes: typeof obj.notes === 'string' ? obj.notes : undefined };
  } catch {
    return { tasks: [] };
  }
}

function normalizeRole(role: unknown): NewTask['role'] {
  const allowed = ['impl', 'qa', 'frontend', 'backend', 'docs', 'other'] as const;
  const r = String(role ?? 'impl').toLowerCase();
  return (allowed as readonly string[]).includes(r) ? (r as NewTask['role']) : 'impl';
}

// ── implement phase ─────────────────────────────────────────────────────────

export function buildImplementPrompt(ctx: PromptContext, tasks: IssueTask[], extra?: string): string {
  const checklist = tasks.length
    ? tasks.map((t) => `- [ ] (${t.role}) ${t.title}${t.intent ? ` — ${t.intent}` : ''}`).join('\n')
    : '_(no pre-planned tasks — decide the steps yourself)_';

  return withPolicy(
    `${issueBrief(ctx)}

---

You are the **implementing engineer**. Implement this issue end to end in the current worktree.

Planned checklist:
${checklist}

Guidelines:
- Make the smallest correct change that satisfies the acceptance criteria.
- Match the existing code style and patterns in this repository.
- If the project has tests or a build, run them and fix what you broke.
- You do NOT need to create a git commit — the orchestrator commits your changes after this step.

When finished, end with a one-paragraph summary of what you changed and how you verified it.`,
    extra,
  );
}

// ── qa phase ────────────────────────────────────────────────────────────────

export function buildQaPrompt(ctx: PromptContext, extra?: string): string {
  return withPolicy(
    `${issueBrief(ctx)}

---

You are an independent **QA engineer**. The implementation for this issue has been committed to the
current worktree. Your job is to verify it against the acceptance criteria — do not implement new
features, but you MAY make trivial fixes if something is clearly broken.

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
  const match = text.match(/QA_RESULT:\s*(PASS|FAIL)\s*[—\-:]*\s*(.*)/i);
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
