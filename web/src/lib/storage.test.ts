import { describe, it, expect, beforeEach } from 'vitest'
import {
  StorageKeys,
  projectViewKey,
  selectedAgentKey,
  artifactPrefsKey,
  artifactTagFilterKey,
  agentViewPrefsKey,
  archivedCollapsedKey,
  promptDraftKey,
  promptScrollKey,
  imageCounterKey,
  readLocal,
  writeLocal,
  readTrustedProjects,
  isProjectTrusted,
  trustProject,
} from './storage'

describe('per-id key builders', () => {
  it('projectViewKey embeds the project id with the shared prefix', () => {
    expect(projectViewKey('proj1')).toBe('hydra-project-view-proj1')
  })

  it('selectedAgentKey embeds the project id with the shared prefix', () => {
    expect(selectedAgentKey('proj1')).toBe('hydra-selected-agent-proj1')
  })

  it('archivedCollapsedKey embeds the project id with the shared prefix', () => {
    expect(archivedCollapsedKey('proj1')).toBe('hydra-archived-collapsed-proj1')
  })

  it('agentViewPrefsKey includes project and agent ids', () => {
    expect(agentViewPrefsKey('proj1', 'agentA')).toBe('hydra-agent-view-proj1-agentA')
  })

  it('agentViewPrefsKey falls back to "_" when projectId is null', () => {
    expect(agentViewPrefsKey(null, 'agentA')).toBe('hydra-agent-view-_-agentA')
  })

  it('artifactPrefsKey includes project, agent, and artifact name', () => {
    expect(artifactPrefsKey('proj1', 'agentA', 'shots')).toBe('hydra-artifact-proj1-agentA-shots')
  })

  it('artifactPrefsKey falls back to "_" when projectId is null', () => {
    expect(artifactPrefsKey(null, 'agentA', 'shots')).toBe('hydra-artifact-_-agentA-shots')
  })

  it('artifactTagFilterKey includes project and agent under the v2 prefix', () => {
    expect(artifactTagFilterKey('proj1', 'agentA')).toBe('hydra-artifact-tagfilter-v2-proj1-agentA')
  })

  it('artifactTagFilterKey falls back to "_" when projectId is null', () => {
    expect(artifactTagFilterKey(null, 'agentA')).toBe('hydra-artifact-tagfilter-v2-_-agentA')
  })

  it('promptDraftKey distinguishes compact vs full layout', () => {
    expect(promptDraftKey('proj1', true)).toBe('hydra-prompt-draft-compact-proj1')
    expect(promptDraftKey('proj1', false)).toBe('hydra-prompt-draft-full-proj1')
  })

  it('promptScrollKey distinguishes compact vs full layout', () => {
    expect(promptScrollKey('proj1', true)).toBe('hydra-prompt-scroll-compact-proj1')
    expect(promptScrollKey('proj1', false)).toBe('hydra-prompt-scroll-full-proj1')
  })

  it('imageCounterKey distinguishes compact vs full layout', () => {
    expect(imageCounterKey('proj1', true)).toBe('hydra-image-counter-compact-proj1')
    expect(imageCounterKey('proj1', false)).toBe('hydra-image-counter-full-proj1')
  })
})

describe('key builders: distinctness and stability', () => {
  it('produces distinct keys for distinct project ids', () => {
    expect(projectViewKey('a')).not.toBe(projectViewKey('b'))
    expect(agentViewPrefsKey('a', 'x')).not.toBe(agentViewPrefsKey('b', 'x'))
  })

  it('produces distinct keys for distinct agent ids', () => {
    expect(agentViewPrefsKey('p', 'a')).not.toBe(agentViewPrefsKey('p', 'b'))
    expect(artifactTagFilterKey('p', 'a')).not.toBe(artifactTagFilterKey('p', 'b'))
  })

  it('produces distinct keys for distinct artifact names', () => {
    expect(artifactPrefsKey('p', 'a', 'one')).not.toBe(artifactPrefsKey('p', 'a', 'two'))
  })

  it('null projectId does not collide with a literal "_" projectId differently than documented', () => {
    // Both map to the same stable shape — that is the documented behaviour.
    expect(agentViewPrefsKey(null, 'a')).toBe(agentViewPrefsKey('_', 'a'))
  })

  it('is stable for the same inputs across calls', () => {
    expect(agentViewPrefsKey('p', 'a')).toBe(agentViewPrefsKey('p', 'a'))
    expect(promptDraftKey('p', true)).toBe(promptDraftKey('p', true))
  })

  it('every built key shares the hydra- prefix', () => {
    const keys = [
      projectViewKey('p'),
      selectedAgentKey('p'),
      archivedCollapsedKey('p'),
      agentViewPrefsKey('p', 'a'),
      artifactPrefsKey('p', 'a', 'n'),
      artifactTagFilterKey('p', 'a'),
      promptDraftKey('p', true),
      promptScrollKey('p', false),
      imageCounterKey('p', true),
    ]
    for (const k of keys) expect(k.startsWith('hydra-')).toBe(true)
  })

  it('static StorageKeys all share the hydra- prefix', () => {
    for (const v of Object.values(StorageKeys)) {
      expect(typeof v).toBe('string')
      expect(v.startsWith('hydra-')).toBe(true)
    }
  })
})

describe('readLocal / writeLocal round-trip', () => {
  beforeEach(() => localStorage.clear())

  it('writes then reads back the same value', () => {
    writeLocal('hydra-test-key', 'hello')
    expect(readLocal('hydra-test-key')).toBe('hello')
  })

  it('returns null for an unset key', () => {
    expect(readLocal('hydra-missing')).toBe(null)
  })

  it('removes the key when written with null', () => {
    writeLocal('hydra-test-key', 'v')
    writeLocal('hydra-test-key', null)
    expect(readLocal('hydra-test-key')).toBe(null)
  })
})

describe('readLocal / writeLocal swallow throws', () => {
  it('readLocal returns null when getItem throws', () => {
    const orig = localStorage.getItem
    localStorage.getItem = () => { throw new Error('blocked') }
    try {
      expect(readLocal('anything')).toBe(null)
    } finally {
      localStorage.getItem = orig
    }
  })

  it('writeLocal does not throw when setItem throws', () => {
    const orig = localStorage.setItem
    localStorage.setItem = () => { throw new Error('quota') }
    try {
      expect(() => writeLocal('anything', 'v')).not.toThrow()
    } finally {
      localStorage.setItem = orig
    }
  })

  it('writeLocal does not throw when removeItem throws', () => {
    const orig = localStorage.removeItem
    localStorage.removeItem = () => { throw new Error('blocked') }
    try {
      expect(() => writeLocal('anything', null)).not.toThrow()
    } finally {
      localStorage.removeItem = orig
    }
  })
})

describe('trusted projects', () => {
  beforeEach(() => localStorage.clear())

  it('starts empty', () => {
    expect(readTrustedProjects().size).toBe(0)
    expect(isProjectTrusted('p')).toBe(false)
  })

  it('records and reports a trusted project', () => {
    trustProject('p1')
    expect(isProjectTrusted('p1')).toBe(true)
    expect(readTrustedProjects().has('p1')).toBe(true)
  })

  it('is idempotent and accumulates distinct ids', () => {
    trustProject('p1')
    trustProject('p1')
    trustProject('p2')
    const ids = readTrustedProjects()
    expect(ids.size).toBe(2)
    expect([...ids].sort()).toEqual(['p1', 'p2'])
  })

  it('ignores malformed stored JSON', () => {
    writeLocal(StorageKeys.trustedProjects, '{not json')
    expect(readTrustedProjects().size).toBe(0)
  })

  it('ignores a non-array stored value', () => {
    writeLocal(StorageKeys.trustedProjects, JSON.stringify({ p1: true }))
    expect(readTrustedProjects().size).toBe(0)
  })

  it('filters out non-string entries', () => {
    writeLocal(StorageKeys.trustedProjects, JSON.stringify(['ok', 5, null, 'good']))
    expect([...readTrustedProjects()].sort()).toEqual(['good', 'ok'])
  })
})
