import type {
  AskMessage,
  AskSuggestion,
  Issue,
  IssuePlanContext,
  IssueTask,
  PlanKeyFile,
  Project,
  ProjectNote,
  RunPhase,
  StoryReferenceContext,
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
  /** Explicit context snapshots from predecessor stories in this issue chain. */
  storyContext?: StoryReferenceContext[];
  /** Current revision round (1 = first build, 2+ = re-run after the human requested changes). */
  round?: number;
  /** The human's "request changes" feedback driving this round (round >= 2). */
  revisionFeedback?: string | null;
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
  // Multi-round loop engineering: when a human requested changes at the review gate, this is the
  // most important instruction for the round — surface it prominently, above project context.
  if (ctx.revisionFeedback?.trim()) {
    lines.push(
      ``,
      `## Revision requested (round ${ctx.round ?? 2})`,
      `A human reviewed the previous round and asked for changes. This is a NEW round of work on the` +
        ` SAME branch and worktree — build on the existing commits, do not start over. Treat the` +
        ` feedback below as the top priority, then re-confirm the original acceptance criteria still hold:`,
      ``,
      ctx.revisionFeedback.trim().slice(0, 4_000),
    );
  }
  if (project.context?.trim()) {
    lines.push(``, `## Project context`, project.context.trim());
  }
  const storyContext = (ctx.storyContext ?? []).slice(0, 5);
  if (storyContext.length) {
    lines.push(``, `## Referenced predecessor story context`);
    for (const ref of storyContext) {
      lines.push(
        ``,
        `### ${ref.source_key}: ${ref.source_title}`,
        ref.context_summary.trim().slice(0, 2_000),
      );
    }
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

// ── ask: conversational project Q&A ──────────────────────────────────────────

const ASK_FENCE = 'symphony-ask';

/**
 * Prompt for the project "ask" feature: a read-only agent that answers a user's question about
 * the repository, then decides whether the exchange describes concrete work and, if so, drafts a
 * feature/bug the user can one-click create. The prior turns are embedded so the conversation is
 * coherent without depending on CLI session resume (which differs per agent).
 */
export function buildAskPrompt(project: Project, history: AskMessage[], question: string): string {
  const lines: string[] = [
    `# Ask — ${project.name} (${project.key})`,
    ``,
    `You are a senior engineer who knows this repository well. A user is asking about this project`,
    `in a conversation. Read the relevant parts of the repository so your answer reflects how the`,
    `code actually works today — do not guess.`,
  ];
  if (project.context?.trim()) {
    lines.push(``, `## Project context`, project.context.trim());
  }
  const recent = history.slice(-12); // bound the embedded transcript; keep the latest turns
  if (recent.length) {
    lines.push(``, `## Conversation so far`);
    for (const m of recent) {
      lines.push(``, `**${m.role === 'user' ? 'User' : 'You'}:** ${m.content.trim().slice(0, 4_000)}`);
    }
  }
  lines.push(
    ``,
    `## User's question`,
    question.trim(),
    ``,
    `---`,
    ``,
    `Answer the question directly and conversationally. Guidelines:`,
    `- Ground every claim in the actual code; read files or grep as needed before answering.`,
    `- Write a clear, well-structured answer in Markdown that a non-author can follow — short`,
    `  paragraphs and bullets, and reference concrete files/symbols (e.g. \`path/to/file.ts\`).`,
    `- You may suggest improvements when they are relevant to the question.`,
    `- This is READ-ONLY: do not modify, create, or delete any files, and do not commit.`,
    `- You are unattended — never use interactive tools. If something is ambiguous, state your`,
    `  assumption and answer the most useful interpretation.`,
    ``,
    `After your answer, decide whether what was discussed should become a concrete unit of work`,
    `(a new feature or bug fix) in this project. End your response with EXACTLY ONE fenced code`,
    `block tagged \`${ASK_FENCE}\` containing JSON:`,
    ``,
    '```' + ASK_FENCE,
    `{`,
    `  "convertible": true,`,
    `  "type": "feature",`,
    `  "title": "short imperative issue title",`,
    `  "description": "what should change and why, in the user's context",`,
    `  "acceptance_criteria": "- a checkable outcome\\n- another"`,
    `}`,
    '```',
    ``,
    `Set \`"convertible": false\` (other fields optional) when the exchange is purely informational`,
    `and there is nothing concrete to build. \`type\` is "feature" or "bug".`,
  );
  return lines.join('\n');
}

export interface ParsedAsk {
  answer: string;
  suggestion: AskSuggestion | null;
}

/**
 * Split the agent's reply into the human-facing answer (fence removed) and an optional draft
 * issue. A missing/malformed fence is non-fatal — the answer still stands, just without a
 * conversion offer.
 */
export function parseAsk(text: string): ParsedAsk {
  const raw = text ?? '';
  const fence = extractFenced(raw, ASK_FENCE);
  const answer = stripFenced(raw, ASK_FENCE).trim() || raw.trim();

  let suggestion: AskSuggestion | null = null;
  if (fence) {
    try {
      const obj = JSON.parse(fence) as Record<string, unknown>;
      const title = String(obj.title ?? '').trim();
      if (obj.convertible === true && title) {
        suggestion = {
          type: obj.type === 'bug' ? 'bug' : 'feature',
          title: title.slice(0, 200),
          description: String(obj.description ?? '').trim(),
          acceptance_criteria: String(obj.acceptance_criteria ?? '').trim(),
        };
      }
    } catch {
      /* malformed suggestion — drop it, keep the answer */
    }
  }
  return { answer, suggestion };
}

// ── merge-conflict resolution ────────────────────────────────────────────────

/** Input the approve flow hands the conflict resolver (structural copy of MergeConflictResolverInput). */
export interface ConflictPromptInput {
  base: string;
  branch: string;
  checkoutPath: string;
  mergeOutput: string;
  conflictedFiles: string[];
}

/** Prompt for the automated merge-conflict resolver run during review approval. */
export function buildConflictPrompt(issue: Issue, project: Project, input: ConflictPromptInput): string {
  return [
    `Resolve the merge conflict for ${issue.key}: ${issue.title}.`,
    '',
    `Project: ${project.name} (${project.key})`,
    `Target branch: ${input.base}`,
    `Agent branch: ${input.branch}`,
    `Integration worktree: ${input.checkoutPath}`,
    '',
    'Issue description:',
    issue.description?.trim() || '_(none)_',
    '',
    'Acceptance criteria:',
    issue.acceptance_criteria?.trim() || '_(none)_',
    '',
    'Merge output:',
    input.mergeOutput,
    '',
    'Conflicted files:',
    ...input.conflictedFiles.map((file) => `- ${file}`),
    '',
    'Instructions:',
    '- Preserve the current target-branch behavior and the story implementation.',
    '- Resolve every conflict marker in the conflicted files.',
    '- Read nearby files when needed, but keep edits tightly scoped to the integration conflict.',
    '- Do not commit; Symphony will stage and commit the merge after checking your work.',
    '- Run lightweight checks when useful, and finish with a short summary of what you resolved.',
  ].join('\n');
}

// ── fenced-block helpers ────────────────────────────────────────────────────

// `\\s*\\n?` (newline optional) so a same-line fence (```tag {json}```) is matched too — both
// extract and strip must agree, or a malformed fence would leak its raw JSON into the answer.
function extractFenced(text: string, tag: string): string | null {
  const re = new RegExp('```' + tag + '\\s*\\n?([\\s\\S]*?)```', 'i');
  const m = text.match(re);
  return m ? m[1]!.trim() : null;
}

/** Remove a fenced block (including its fences) from the text — used to hide the ask suggestion. */
function stripFenced(text: string, tag: string): string {
  const re = new RegExp('```' + tag + '\\s*\\n?[\\s\\S]*?```', 'i');
  return text.replace(re, '');
}

function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
