import { beforeEach, describe, expect, it } from 'vitest'
import { recordModelProviderUse, orderModelProviders, readModelProviderRecency } from './modelProviderRecency'
import { StorageKeys } from './storage'

const providers = [
  { id: 'claude' as const },
  { id: 'codex' as const },
  { id: 'gemini' as const },
  { id: 'copilot' as const },
]

describe('model provider recency', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the active provider first and uses recent providers for the rest', () => {
    expect(orderModelProviders(providers, 'gemini', ['codex', 'claude'])).toEqual([
      providers[2], providers[1], providers[0], providers[3],
    ])
  })

  it('preserves the curated provider order when there is no history', () => {
    expect(orderModelProviders(providers, 'claude', [])).toEqual(providers)
  })

  it('records a provider only once at the front of the history', () => {
    recordModelProviderUse('claude')
    recordModelProviderUse('codex')
    recordModelProviderUse('claude')

    expect(readModelProviderRecency()).toEqual(['claude', 'codex'])
    expect(localStorage.getItem(StorageKeys.modelProviderRecency)).toBe('["claude","codex"]')
  })
})
