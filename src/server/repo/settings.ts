import { getDb } from '../db/client';
import { resolveConfig, type EngineConfig } from '../core/config';

export function getAllSettings(): Record<string, unknown> {
  const rows = getDb()
    .prepare(`SELECT key, value FROM settings`)
    .all() as { key: string; value: string }[];
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value));
}

export function setSettings(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) setSetting(key, value);
}

/** Effective engine configuration: defaults merged with the settings table. */
export function getConfig(): EngineConfig {
  return resolveConfig(getAllSettings());
}
