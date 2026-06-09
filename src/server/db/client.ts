import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../env';
import { bootstrap } from './migrate';

let _db: DatabaseSync | null = null;

/**
 * Returns the process-wide SQLite connection, opening + bootstrapping it on first use.
 * The path is resolved from env at first call, so tests can point SYMPHONY_DB_PATH at a
 * throwaway file before any repo module runs a query.
 */
export function getDb(): DatabaseSync {
  if (_db) return _db;
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const db = new DatabaseSync(DB_PATH);
  bootstrap(db);
  _db = db;
  return _db;
}

/** Close + drop the singleton. Intended for tests that swap databases between runs. */
export function closeDb(): void {
  _db?.close();
  _db = null;
}
