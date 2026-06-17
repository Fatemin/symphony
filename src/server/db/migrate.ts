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
  seedSettings(db);
}

/** Best-effort `ALTER TABLE … ADD COLUMN`; a duplicate-column error means it already exists. */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {
    /* column already present */
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
