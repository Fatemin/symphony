import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();

/** Where the SQLite file and other runtime data live. */
export const DATA_DIR = process.env.SYMPHONY_DATA_DIR
  ? path.resolve(process.env.SYMPHONY_DATA_DIR)
  : path.join(ROOT, 'data');

/** SQLite database file path. Overridable for tests via SYMPHONY_DB_PATH. */
export const DB_PATH = process.env.SYMPHONY_DB_PATH
  ? path.resolve(process.env.SYMPHONY_DB_PATH)
  : path.join(DATA_DIR, 'symphony.db');

/** Default root under which per-issue git worktrees are created. */
export const DEFAULT_WORKSPACE_ROOT =
  process.env.SYMPHONY_WORKSPACE_ROOT
    ? path.resolve(process.env.SYMPHONY_WORKSPACE_ROOT)
    : path.join(os.tmpdir(), 'symphony_workspaces');

export const PORT = Number(process.env.PORT ?? 3001);

export const IS_PROD = process.env.NODE_ENV === 'production';
