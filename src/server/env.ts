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

/**
 * Durable root for uploaded attachment blobs (SYM-35). Derived from DATA_DIR — NOT the workspace
 * root, which is an ephemeral tmpdir reaped between runs. Each blob lives at
 * `<ATTACHMENTS_DIR>/<id>/<sanitized-filename>`; the serve path asserts it never escapes this root.
 */
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

/** Default root under which per-issue git worktrees are created. */
export const DEFAULT_WORKSPACE_ROOT =
  process.env.SYMPHONY_WORKSPACE_ROOT
    ? path.resolve(process.env.SYMPHONY_WORKSPACE_ROOT)
    : path.join(os.tmpdir(), 'symphony_workspaces');

// 3030 by default — deliberately not 3001, which the sibling `agile-with-agent` project uses.
export const PORT = Number(process.env.PORT ?? 3030);

export const IS_PROD = process.env.NODE_ENV === 'production';
