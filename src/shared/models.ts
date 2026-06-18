// Curated model ids selectable in the Settings UI (passed to the CLI's `--model`/`-m`).
// The CLI accepts any model id, so this list only drives the dropdown — a value outside it
// (e.g. set via the API or an older settings row) is still honored and shown as "custom".
import type { AgentType } from './types';

export interface ModelOption {
  id: string;
  label: string;
  /** Which agent CLI this model belongs to (filters the model dropdown by selected agent). */
  agent?: AgentType;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable Opus', agent: 'claude' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', agent: 'claude' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', agent: 'claude' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — speed/cost balance (default)', agent: 'claude' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest, cheapest', agent: 'claude' },
  { id: 'claude-fable-5', label: 'Claude Fable 5 — premium, most intelligent', agent: 'claude' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex — Codex default', agent: 'codex' },
  { id: 'gpt-5', label: 'GPT-5', agent: 'codex' },
];

export interface AgentOption {
  id: AgentType;
  label: string;
}

export const AGENT_OPTIONS: AgentOption[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];
