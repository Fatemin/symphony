import { customAlphabet, nanoid } from 'nanoid';

/** Opaque primary-key generator for rows (URL-safe, 16 chars). */
export const newId = (): string => nanoid(16);

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const randomKey = customAlphabet(KEY_ALPHABET, 3);

/** Derive a short uppercase project key (e.g. "Web App" → "WEB"). Falls back to random. */
export function deriveProjectKey(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length >= 3) return letters.slice(0, 3);
  if (letters.length > 0) return (letters + randomKey()).slice(0, 3);
  return randomKey();
}

/** Compose a human-readable issue key, e.g. ("WEB", 12) → "WEB-12". */
export const issueKey = (projectKey: string, seq: number): string =>
  `${projectKey}-${seq}`;

/**
 * Sanitize an identifier for safe use as a directory name (Symphony §4.2 / §9.5):
 * only [A-Za-z0-9._-] survive; everything else becomes "_".
 */
export const sanitizeWorkspaceKey = (identifier: string): string =>
  identifier.replace(/[^A-Za-z0-9._-]/g, '_');

/** Git branch name for an issue's agent work. */
export const agentBranch = (issueKey: string): string =>
  `agent/${sanitizeWorkspaceKey(issueKey).toLowerCase()}`;
