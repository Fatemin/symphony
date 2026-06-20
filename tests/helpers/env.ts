import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestEnv {
  root: string;
  repoPath: string;
  cleanup: () => void;
}

/**
 * Prepare an isolated test environment: a unique temp dir, env vars pointing the DB + workspace
 * root at it, and a throwaway git repo with one commit on `main` to use as a project's repo_path.
 *
 * MUST be called before dynamically importing any server module, so env.ts reads these paths.
 */
export function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-test-'));
  process.env.SYMPHONY_DB_PATH = path.join(root, 'test.db');
  process.env.SYMPHONY_WORKSPACE_ROOT = path.join(root, 'workspaces');
  // Isolate DATA_DIR too so attachment blobs (ATTACHMENTS_DIR = DATA_DIR/attachments, SYM-35) land in
  // the throwaway dir instead of the repo's ./data. DB_PATH is set explicitly above, so this only
  // redirects the attachments root.
  process.env.SYMPHONY_DATA_DIR = path.join(root, 'data');
  // Isolate the local CLI usage reader (SYM-38) from the developer's real ~/.claude & ~/.codex: point
  // CLAUDE_CONFIG_DIR / CODEX_HOME at throwaway dirs so tests are hermetic and offline. Tests that
  // exercise the reader override these to fixture dirs of their own.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  // SYM-40: Claude's remaining quota now comes from a best-effort LIVE fetch using a local OAuth token.
  // Keep `npm test` hermetic + offline: disable the macOS keychain read and clear any inherited OAuth
  // env token / base-URL override, so the ONLY credential source is a `.credentials.json` a test writes
  // into its own fixture dir (and the one live-path test stubs `globalThis.fetch`). Without this the
  // reader would read the developer's real keychain and hit Anthropic during the suite.
  process.env.SYMPHONY_DISABLE_KEYCHAIN = '1';
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;

  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Symphony Test');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# scratch repo\n');
  g('add', '-A');
  g('commit', '-m', 'init');

  return {
    root,
    repoPath,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
