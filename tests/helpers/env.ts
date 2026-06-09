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
