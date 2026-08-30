import { describe, expect, it } from 'vitest'
import { AGENT_MODELS, CODEX_MODELS } from './agentModels'

describe('agent model options', () => {
  it('shares the Codex picker labels without a GPT prefix', () => {
    expect(CODEX_MODELS).toEqual([
      { id: 'gpt-5.6-sol', label: '5.6 Sol' },
      { id: 'gpt-5.6-terra', label: '5.6 Terra' },
      { id: 'gpt-5.6-luna', label: '5.6 Luna' },
      { id: 'gpt-5.5', label: '5.5' },
      { id: 'gpt-5.4', label: '5.4' },
      { id: 'gpt-5.4-mini', label: '5.4 Mini' },
    ])
    expect(AGENT_MODELS.codex).toBe(CODEX_MODELS)
  })
})
