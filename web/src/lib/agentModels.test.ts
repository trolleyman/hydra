import { describe, expect, it } from 'vitest'
import { AGENT_MODELS, CLAUDE_MODELS, CODEX_MODELS } from './agentModels'

describe('agent model options', () => {
  it('offers the current provider model generations', () => {
    expect(CLAUDE_MODELS).toEqual([
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ])
    expect(AGENT_MODELS.gemini).toEqual([
      { id: 'gemini-4-argon', label: '4 Argon' },
      { id: 'gemini-3.8-flash', label: '3.8 Flash' },
      { id: 'gemini-3.5-flash-lite', label: '3.5 Flash-Lite' },
    ])
    expect(CODEX_MODELS).toEqual([
      { id: 'gpt-6-astra', label: '6 Astra' },
      { id: 'gpt-6.1-sol', label: '6.1 Sol' },
      { id: 'gpt-6.1-terra', label: '6.1 Terra' },
      { id: 'gpt-6-luna', label: '6 Luna' },
    ])
    expect(AGENT_MODELS.claude).toBe(CLAUDE_MODELS)
    expect(AGENT_MODELS.codex).toBe(CODEX_MODELS)
  })
})
