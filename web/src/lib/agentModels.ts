import type { AgentTypeOption } from './spawnDefaults'

export type AgentModel = { id: string; label: string }

// Curated model aliases shown in the agent and model pickers. The empty
// "Default" choice is added by each picker so the CLI can select its own model.
// Claude's explicit Opus ids distinguish versions when matching model labels.
export const AGENT_MODELS: Record<AgentTypeOption, AgentModel[]> = {
  claude: [
    { id: 'fable', label: 'Fable' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  ],
  copilot: [],
  codex: [
    { id: 'gpt-5.6-sol', label: '5.6 Sol' },
    { id: 'gpt-5.6-terra', label: '5.6 Terra' },
    { id: 'gpt-5.6-luna', label: '5.6 Luna' },
    { id: 'gpt-5.5', label: '5.5' },
    { id: 'gpt-5.4', label: '5.4' },
    { id: 'gpt-5.4-mini', label: '5.4 Mini' },
  ],
}

export const CLAUDE_MODELS = AGENT_MODELS.claude
export const CODEX_MODELS = AGENT_MODELS.codex
