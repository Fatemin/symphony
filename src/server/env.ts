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

/**
 * Network interface the server binds to (SYM-42, relaxed in SYM-44). Defaults to `localhost` so an
 * existing install never starts exposing itself on upgrade; LAN access stays an explicit opt-in. Set
 * `HOST=0.0.0.0` (all interfaces) or a specific IP to reach the UI from other LAN devices. Auth is NOT
 * required — `SYMPHONY_AUTH_TOKEN` is optional hardening (see index.ts for the non-loopback warning).
 */
export const HOST = process.env.HOST?.trim() || 'localhost';

/**
 * Optional shared secret for the minimal access-control middleware (SYM-42). Opt-in hardening, not a
 * requirement (SYM-44 dropped the forced-auth-on-LAN rule). Env-only **by design**: it must never live
 * in the `settings` table because `GET /api/ops/settings` returns that to the client and would leak it.
 * Empty/whitespace ⇒ `undefined` ⇒ auth disabled (the default).
 */
export const AUTH_TOKEN = process.env.SYMPHONY_AUTH_TOKEN?.trim() || undefined;
