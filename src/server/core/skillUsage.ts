// SYM-62: surface which Claude Code skills an issue used, at the tail of the delivery summary.
// These helpers stay PURE (no DB / IO imports) so detection + formatting are isolated and
// unit-testable; the sequencer (`phases/index.ts`) wires them to round-scoped `agent.tool`
// events, which are durable across retries (an in-memory per-call set would miss skills used on
// an earlier attempt that `skipCompletedPhase` later skips).

/** Claude Code's built-in skill mechanism surfaces as a tool call named exactly `Skill`. */
export const SKILL_TOOL_NAME = 'Skill';

/**
 * Pull the skill slug out of a `Skill` tool_use input. The canonical field is `skill`; `command`
 * and `name` are accepted as defensive fallbacks for runner-shape drift. Returns `null` when the
 * input is not an object or carries no usable (non-blank string) slug.
 */
export function extractSkillName(input: unknown): string | null {
  if (input == null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['skill', 'command', 'name'] as const) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/**
 * Append a deterministic `## Skills used` section listing the given skill slugs. Returns `report`
 * unchanged when no skills were used, so an issue that used none never grows a spurious tail. A
 * null/blank report with skills present yields the section alone. The slugs are rendered as inline
 * code and the caller is expected to pass them already deduped/sorted.
 */
export function appendSkillsUsedSection(
  report: string | null,
  skills: readonly string[],
): string | null {
  if (skills.length === 0) return report;
  const list = skills.map((slug) => `\`${slug}\``).join(', ');
  const section = `## Skills used\n\nThis issue used the following skill(s): ${list}.`;
  const trimmed = report?.trim();
  return trimmed ? `${trimmed}\n\n${section}` : section;
}
