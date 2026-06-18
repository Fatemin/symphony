// Curated Claude model ids selectable in the Settings UI (passed to the CLI's `--model`).
// The CLI accepts any model id, so this list only drives the dropdown — a value outside it
// (e.g. set via the API or an older settings row) is still honored and shown as "custom".
export interface ModelOption {
  id: string;
  label: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable Opus' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — speed/cost balance (default)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest, cheapest' },
  { id: 'claude-fable-5', label: 'Claude Fable 5 — premium, most intelligent' },
];
