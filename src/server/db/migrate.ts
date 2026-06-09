import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema';
import { DEFAULT_SETTINGS } from '../core/config';

/**
 * Applies the schema and seeds default settings. Idempotent — safe to run on every boot.
 * Additive column changes can be added here as best-effort `ALTER TABLE` guarded by try/catch.
 */
export function bootstrap(db: DatabaseSync): void {
  db.exec(SCHEMA);
  seedSettings(db);
}

function seedSettings(db: DatabaseSync): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, JSON.stringify(value));
  }
}
