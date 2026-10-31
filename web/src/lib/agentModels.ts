import type { AgentTypeOption } from './spawnDefaults'

export type AgentModel = { id: string; label: string }

// Curated model aliases shown in the agent and model pickers. The empty
// "Default" choice is added by each picker so the CLI can select its own model.
// Explicit provider ids keep the labels tied to the current model generation.
export const AGENT_MODELS: Record<AgentTypeOption, AgentModel[]> = {
  claude: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
  gemini: [
    { id: 'gemini-4-argon', label: '4 Argon' },
    { id: 'gemini-3.8-flash', label: '3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: '3.5 Flash-Lite' },
  ],
  copilot: [],
  codex: [
    { id: 'gpt-6-astra', label: '6 Astra' },
    { id: 'gpt-6.1-sol', label: '6.1 Sol' },
    { id: 'gpt-6.1-terra', label: '6.1 Terra' },
    { id: 'gpt-6-luna', label: '6 Luna' },
  ],
}

export const CLAUDE_MODELS = AGENT_MODELS.claude
export const CODEX_MODELS = AGENT_MODELS.codex
