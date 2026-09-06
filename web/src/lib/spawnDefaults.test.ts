import { beforeEach, describe, expect, it } from 'vitest'
import { readEffortMap, spawnDefaultFields } from './spawnDefaults'
import { StorageKeys } from './storage'

describe('spawn defaults', () => {
  beforeEach(() => localStorage.clear())

  it('remembers thinking effort per provider', () => {
    localStorage.setItem(StorageKeys.defaultEffort, JSON.stringify({ claude: 'high', codex: 'low' }))

    expect(readEffortMap()).toEqual({ claude: 'high', codex: 'low' })
    localStorage.setItem(StorageKeys.defaultAgentType, 'codex')
    expect(spawnDefaultFields()).toMatchObject({ agent_type: 'codex', effort: 'low' })
  })

  it('does not send a stale effort for an unsupported provider', () => {
    localStorage.setItem(StorageKeys.defaultAgentType, 'gemini')
    localStorage.setItem(StorageKeys.defaultEffort, JSON.stringify({ gemini: 'high' }))

    expect(spawnDefaultFields()).not.toHaveProperty('effort')
  })

  it('ignores malformed effort preferences', () => {
    localStorage.setItem(StorageKeys.defaultEffort, '{')

    expect(readEffortMap()).toEqual({})
  })
})
