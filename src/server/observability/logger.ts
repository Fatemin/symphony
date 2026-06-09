import type { EventLevel } from '../../shared/types';

// Structured key=value logging to stderr (Symphony §13.1). Kept tiny and dependency-free.

const ORDER: Record<EventLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: EventLevel = (process.env.LOG_LEVEL as EventLevel) || 'info';

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return /[\s="]/.test(s) ? JSON.stringify(s) : s;
}

function emit(level: EventLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return;
  const parts = [`ts=${new Date().toISOString()}`, `level=${level}`, `msg=${fmt(msg)}`];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v !== undefined) parts.push(`${k}=${fmt(v)}`);
  }
  process.stderr.write(parts.join(' ') + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
