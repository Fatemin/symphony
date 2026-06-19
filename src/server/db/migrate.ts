import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema';
import { DEFAULT_SETTINGS } from '../core/config';

/**
 * Applies the schema and seeds default settings. Idempotent — safe to run on every boot.
 * Additive column changes can be added here as best-effort `ALTER TABLE` guarded by try/catch.
 */
export function bootstrap(db: DatabaseSync): void {
  db.exec(SCHEMA);
  // Additive column backfills for DBs created before a column existed.
  addColumn(db, 'projects', 'preview_command', 'TEXT');
  addColumn(db, 'projects', 'config', 'TEXT');
  addColumn(db, 'projects', 'agent', 'TEXT');
  addColumn(db, 'runs', 'report', 'TEXT');
  addColumn(db, 'runs', 'cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'runs', 'cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'issues', 'round', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'issues', 'merge_conflict', 'TEXT'); // SYM-29: git-conflict decoration at the review gate
  addColumn(db, 'runs', 'round', 'INTEGER NOT NULL DEFAULT 1');
  seedSettings(db);
  backfillMaxTurns(db);
  backfillCancelledAbortedRuns(db);
}

/**
 * One-off value backfill: the seeded max_turns default moved 60 → 120 after two implement
 * phases died at the 61st turn. Gated by a marker row so it runs exactly once per DB —
 * without the gate it would re-fire on every boot and silently revert a user who later
 * chooses 60 on purpose. (A pre-existing deliberate 60 is indistinguishable from the seeded
 * default and gets rewritten the one time; that is the accepted trade-off.)
 */
function backfillMaxTurns(db: DatabaseSync): void {
  const marker = 'migration:max_turns_120';
  const done = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(marker);
  if (done) return;
  db.prepare(
    `UPDATE settings SET value = '120', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE key = 'max_turns' AND value = '60'`,
  ).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, '"applied"')`).run(marker);
}

/** Correct old human-cancelled runs that were recorded as planner failures. */
function backfillCancelledAbortedRuns(db: DatabaseSync): void {
  const marker = 'migration:cancelled_aborted_runs';
  const done = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(marker);
  if (done) return;
  db.prepare(
    `UPDATE runs
       SET status = 'cancelled'
     WHERE status = 'failed'
       AND error = 'aborted'
       AND issue_id IN (SELECT id FROM issues WHERE status = 'cancelled')`,
  ).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, '"applied"')`).run(marker);
}

/** Best-effort `ALTER TABLE … ADD COLUMN`; only a duplicate-column error means "already there". */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    // Swallow ONLY the idempotency case. Anything else (locked/readonly DB) must stay loud —
    // otherwise the miss surfaces later as opaque per-run "no such column" UPDATE failures.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

function seedSettings(db: DatabaseSync): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, JSON.stringify(value));
  }
}
