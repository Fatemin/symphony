// Pure key derivation shared between the server and the web client.
// Kept free of nanoid (and any Node-only dependency) so the Vite client can import it directly —
// the server's deriveProjectKey (src/server/core/keys.ts) layers a random fallback on top of this.

/**
 * The deterministic part of a project key: the name's uppercase letters, first three
 * (e.g. "ops-supplier" → "OPS", "Web App" → "WEB"). Returns "" when the name has no letters,
 * which the server resolves with a random key and the form leaves for the user to fill in.
 */
export function suggestProjectKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
}
