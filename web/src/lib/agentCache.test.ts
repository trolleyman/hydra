import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadCachedAgents, saveCachedAgents, pruneAgentCaches } from './agentCache'
import { agentsCacheKey } from './storage'
import type { AgentResponse } from '../api'

function agent(id: string): AgentResponse {
  return { id, agent_type: 'claude', base_branch: 'main', session_pid: 0, session_status: 'running' } as AgentResponse
}

describe('agentCache', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('round-trips a project list', () => {
    saveCachedAgents('proj-1', [agent('a1'), agent('a2')])
    expect(loadCachedAgents('proj-1')?.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('keeps projects isolated', () => {
    saveCachedAgents('A', [agent('a1')])
    saveCachedAgents('B', [agent('b1')])
    expect(loadCachedAgents('A')?.map((a) => a.id)).toEqual(['a1'])
    expect(loadCachedAgents('B')?.map((a) => a.id)).toEqual(['b1'])
  })

  it('returns null for an unknown project', () => {
    expect(loadCachedAgents('never-set')).toBeNull()
  })

  it('returns null for an empty stored list, so the caller can tell "nothing cached" apart from "no agents"', () => {
    saveCachedAgents('proj-1', [])
    expect(loadCachedAgents('proj-1')).toBeNull()
  })

  it('caps how many agents are stored', () => {
    saveCachedAgents('proj-1', Array.from({ length: 100 }, (_, i) => agent(`a${i}`)))
    expect(loadCachedAgents('proj-1')).toHaveLength(60)
  })

  it('drops entries without a usable id rather than caching a row nothing can key', () => {
    localStorage.setItem(
      agentsCacheKey('proj-1'),
      JSON.stringify({ t: Date.now(), agents: [agent('a1'), { id: '' }, null, { title: 'no id' }] }),
    )
    expect(loadCachedAgents('proj-1')?.map((a) => a.id)).toEqual(['a1'])
  })

  it('returns null for malformed storage, without throwing', () => {
    localStorage.setItem(agentsCacheKey('proj-1'), '{not json')
    expect(() => loadCachedAgents('proj-1')).not.toThrow()
    expect(loadCachedAgents('proj-1')).toBeNull()

    localStorage.setItem(agentsCacheKey('proj-2'), JSON.stringify({ t: Date.now(), agents: 'nope' }))
    expect(loadCachedAgents('proj-2')).toBeNull()
  })

  it('expires an entry older than the TTL, and prune removes it', () => {
    saveCachedAgents('proj-1', [agent('a1')])
    // Eight days on: past the one-week TTL.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000)

    expect(loadCachedAgents('proj-1')).toBeNull()
    expect(localStorage.getItem(agentsCacheKey('proj-1'))).not.toBeNull()
    pruneAgentCaches()
    expect(localStorage.getItem(agentsCacheKey('proj-1'))).toBeNull()
  })

  it('prune keeps fresh entries', () => {
    saveCachedAgents('proj-1', [agent('a1')])
    pruneAgentCaches()
    expect(loadCachedAgents('proj-1')?.map((a) => a.id)).toEqual(['a1'])
  })
})
