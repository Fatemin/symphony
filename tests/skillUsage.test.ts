import { test } from 'node:test';
import assert from 'node:assert/strict';
// Pure helpers — no DB / env dependency, so this file imports them directly (no setupEnv needed).
import { appendSkillsUsedSection, extractSkillName, SKILL_TOOL_NAME } from '../src/server/core/skillUsage';

test('SKILL_TOOL_NAME is exactly the Claude Code skill tool name', () => {
  assert.equal(SKILL_TOOL_NAME, 'Skill');
});

test('extractSkillName reads the canonical `skill` field', () => {
  assert.equal(extractSkillName({ skill: 'ckm:design' }), 'ckm:design');
});

test('extractSkillName falls back to command then name, with skill winning', () => {
  assert.equal(extractSkillName({ command: 'verify' }), 'verify');
  assert.equal(extractSkillName({ name: 'run' }), 'run');
  assert.equal(extractSkillName({ skill: 'a', command: 'b', name: 'c' }), 'a');
});

test('extractSkillName trims surrounding whitespace', () => {
  assert.equal(extractSkillName({ skill: '  ui-ux-pro-max  ' }), 'ui-ux-pro-max');
});

test('extractSkillName returns null for non-object, missing, or blank slugs', () => {
  assert.equal(extractSkillName(null), null);
  assert.equal(extractSkillName(undefined), null);
  assert.equal(extractSkillName('Skill'), null);
  assert.equal(extractSkillName(42), null);
  assert.equal(extractSkillName({}), null);
  assert.equal(extractSkillName({ skill: '   ' }), null);
  assert.equal(extractSkillName({ skill: 123 }), null);
});

test('appendSkillsUsedSection returns the report unchanged when no skills were used', () => {
  assert.equal(appendSkillsUsedSection("## What's new\nstuff", []), "## What's new\nstuff");
  assert.equal(appendSkillsUsedSection(null, []), null);
});

test('appendSkillsUsedSection appends a section that preserves the original report and lists slugs', () => {
  const out = appendSkillsUsedSection("## What's new\nstuff", ['ckm:design', 'verify']);
  assert.ok(out!.startsWith("## What's new\nstuff"), 'keeps the agent summary on top');
  assert.match(out!, /## Skills used/);
  assert.match(out!, /`ckm:design`, `verify`/);
  assert.ok(out!.endsWith('.'), 'the sentence is punctuated');
});

test('appendSkillsUsedSection yields the section alone when the report is null or blank', () => {
  const expected = '## Skills used\n\nThis issue used the following skill(s): `ckm:design`.';
  assert.equal(appendSkillsUsedSection(null, ['ckm:design']), expected);
  assert.equal(appendSkillsUsedSection('   ', ['ckm:design']), expected);
});
