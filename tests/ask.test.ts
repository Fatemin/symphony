import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/env';
import type { AgentResult, AgentRunInput, AgentRunner } from '../src/server/agent/types';

const env = setupEnv();

const { createProject } = await import('../src/server/repo/projects');
const { listIssues } = await import('../src/server/repo/issues');
const { getConfig } = await import('../src/server/repo/settings');
const { runProjectAsk, askRoutes } = await import('../src/server/http/routes/ask');

test.after(() => env.cleanup());

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, num_turns: 1 };

/** A canned agent reply that captures the input it was given, for read-only/cwd/agent assertions. */
function fakeRunner(text: string, sink?: { input?: AgentRunInput }, ok = true): AgentRunner {
  return async (input) => {
    if (sink) sink.input = input;
    return { ok, sessionId: 'ask-sess', text, usage, durationMs: 1, error: ok ? undefined : 'boom' } as AgentResult;
  };
}

const ANSWER_WITH_SUGGESTION = `The dark-mode toggle lives in \`src/web/theme.tsx\` and persists to localStorage.

It currently only switches a CSS class, so system preference is ignored.

\`\`\`symphony-ask
{
  "convertible": true,
  "type": "feature",
  "title": "Respect the OS color-scheme preference",
  "description": "Default the theme to the user's system setting on first load.",
  "acceptance_criteria": "- Reads prefers-color-scheme\\n- A manual toggle still overrides it"
}
\`\`\``;

test('runProjectAsk answers read-only and surfaces a convertible suggestion', async () => {
  const project = createProject({ name: 'Ask Demo', key: 'ASK', repo_path: env.repoPath });
  const sink: { input?: AgentRunInput } = {};

  const res = await runProjectAsk(
    project,
    { question: 'How does dark mode work?' },
    { runner: fakeRunner(ANSWER_WITH_SUGGESTION, sink), config: getConfig() },
  );

  // The suggestion fence is stripped from the conversational answer…
  assert.ok(res.answer.includes('dark-mode toggle lives'));
  assert.ok(!res.answer.includes('symphony-ask'), 'the suggestion fence must not leak into the answer');
  assert.ok(!res.answer.includes('convertible'));
  // …and parsed into a draft feature.
  assert.equal(res.suggestion?.type, 'feature');
  assert.equal(res.suggestion?.title, 'Respect the OS color-scheme preference');
  assert.match(res.suggestion!.acceptance_criteria, /prefers-color-scheme/);
  assert.equal(res.session_id, 'ask-sess');

  // Ask runs against the live repo, read-only, with the project's default (claude) agent.
  assert.equal(sink.input?.cwd, env.repoPath);
  assert.equal(sink.input?.permissionMode, 'plan');
  assert.equal(sink.input?.agent, 'claude');
  assert.equal(sink.input?.cliPath, getConfig().cli_path);
  // The question and read-only instruction reach the prompt.
  assert.match(sink.input!.prompt, /How does dark mode work\?/);
  assert.match(sink.input!.prompt, /READ-ONLY/);
});

test('runProjectAsk embeds history, honors the agent override, and reports null for informational answers', async () => {
  const project = createProject({ name: 'Ask Codex', key: 'ASKC', repo_path: env.repoPath });
  const sink: { input?: AgentRunInput } = {};

  const res = await runProjectAsk(
    project,
    {
      question: 'And where are the tests?',
      history: [
        { role: 'user', content: 'What test runner is used?' },
        { role: 'assistant', content: 'node:test via tsx.' },
      ],
      agent: 'codex',
    },
    { runner: fakeRunner('Tests live under `tests/`. Nothing to build here.', sink), config: getConfig() },
  );

  assert.equal(res.suggestion, null, 'an informational answer with no fence yields no suggestion');
  assert.equal(res.answer, 'Tests live under `tests/`. Nothing to build here.');

  // The agent override routes to the codex CLI + its default model, and prior turns are embedded.
  assert.equal(sink.input?.agent, 'codex');
  assert.equal(sink.input?.cliPath, getConfig().codex_cli_path);
  assert.equal(sink.input?.model, getConfig().codex_model);
  assert.match(sink.input!.prompt, /What test runner is used\?/);
});

test('POST /:id/ask validates the project, its repo, and the question', async () => {
  // Unknown project → 404.
  const missing = await askRoutes.request('/nope/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(missing.status, 404);

  // Project without a repo → 400 (cannot read a codebase that isn't connected).
  const noRepo = createProject({ name: 'No Repo', key: 'NR' });
  const noRepoRes = await askRoutes.request(`/${noRepo.id}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(noRepoRes.status, 400);

  // Repo present but blank question → 400.
  const project = createProject({ name: 'Ask Validate', key: 'ASKV', repo_path: env.repoPath });
  const blank = await askRoutes.request(`/${project.id}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '   ' }),
  });
  assert.equal(blank.status, 400);

  // No issues were created as a side effect of validation failures.
  assert.equal(listIssues(project.id).length, 0);
});
