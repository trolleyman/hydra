import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  StorageKeys,
  projectViewKey,
  artifactPrefsKey,
  artifactTagFilterKey,
  agentViewPrefsKey,
  archivedCollapsedKey,
  promptDraftKey,
  promptScrollKey,
  imageCounterKey,
  readLocal,
  writeLocal,
  readJSON,
  writeJSON,
  createShardedStore,
} from './storage'

describe('per-id key builders', () => {
  it('projectViewKey embeds the project id with the shared prefix', () => {
    expect(projectViewKey('proj1')).toBe('hydra-project-view-proj1')
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

describe('readJSON / writeJSON', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a JSON value through the identity validator', () => {
    writeJSON('hydra-json', { a: 1, b: ['x'] })
    expect(readJSON('hydra-json', (v) => v)).toEqual({ a: 1, b: ['x'] })
  })

  it('returns null for a missing key', () => {
    expect(readJSON('hydra-missing', (v) => v)).toBe(null)
  })

  it('returns null (without throwing) for malformed JSON', () => {
    localStorage.setItem('hydra-bad', '{not json')
    expect(() => readJSON('hydra-bad', (v) => v)).not.toThrow()
    expect(readJSON('hydra-bad', (v) => v)).toBe(null)
  })

  it('returns whatever the validator returns, including null to reject', () => {
    writeJSON('hydra-num', 42)
    expect(readJSON('hydra-num', (v) => (typeof v === 'number' ? v + 1 : null))).toBe(43)
    writeJSON('hydra-str', 'nope')
    expect(readJSON('hydra-str', (v) => (typeof v === 'number' ? v : null))).toBe(null)
  })

  it('writeJSON removes the key when given null or undefined', () => {
    writeJSON('hydra-json', { a: 1 })
    writeJSON('hydra-json', null)
    expect(readLocal('hydra-json')).toBe(null)
    writeJSON('hydra-json', { a: 1 })
    writeJSON('hydra-json', undefined)
    expect(readLocal('hydra-json')).toBe(null)
  })
})

describe('createShardedStore', () => {
  const PREFIX = 'hydra-test-shard-'
  const TTL = 1000
  type Prefs = { count?: number; label?: string }
  const store = createShardedStore<Prefs>(PREFIX, TTL)
  const key = (id: string) => `${PREFIX}${id}`

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1))
  })
  afterEach(() => vi.useRealTimers())

  it('saves then loads, stamping a numeric timestamp', () => {
    store.save(key('a'), { count: 3, label: 'hi' })
    const loaded = store.load(key('a'))
    expect(loaded).toMatchObject({ count: 3, label: 'hi' })
    expect(typeof loaded?.t).toBe('number')
  })

  it('returns null for a missing or corrupt entry', () => {
    expect(store.load(key('missing'))).toBe(null)
    localStorage.setItem(key('corrupt'), '{not json')
    expect(store.load(key('corrupt'))).toBe(null)
    // An object without the timestamp is treated as corrupt.
    localStorage.setItem(key('notime'), JSON.stringify({ count: 1 }))
    expect(store.load(key('notime'))).toBe(null)
  })

  it('returns null once an entry has outlived the TTL', () => {
    store.save(key('a'), { count: 1 })
    vi.advanceTimersByTime(TTL + 1)
    expect(store.load(key('a'))).toBe(null)
  })

  it('patch merges into the existing entry without clobbering other fields', () => {
    store.save(key('a'), { count: 1, label: 'orig' })
    store.patch(key('a'), { count: 2 })
    expect(store.load(key('a'))).toMatchObject({ count: 2, label: 'orig' })
  })

  it('patch creates a fresh entry when none exists', () => {
    store.patch(key('new'), { label: 'made' })
    expect(store.load(key('new'))).toMatchObject({ label: 'made' })
  })

  it('patch refreshes the TTL so a near-stale entry survives', () => {
    store.save(key('a'), { count: 1 })
    vi.advanceTimersByTime(TTL - 1)
    store.patch(key('a'), { count: 2 })
    vi.advanceTimersByTime(TTL - 1) // total > original TTL, but < TTL since patch
    expect(store.load(key('a'))).toMatchObject({ count: 2 })
  })

  it('prune drops expired and corrupt entries but keeps fresh ones', () => {
    store.save(key('fresh'), { count: 1 })
    store.save(key('stale'), { count: 2 })
    localStorage.setItem(key('corrupt'), '{not json')
    vi.advanceTimersByTime(TTL + 1)
    store.save(key('fresh'), { count: 1 }) // re-stamp so it stays fresh
    store.prune()
    expect(store.load(key('fresh'))).toMatchObject({ count: 1 })
    expect(localStorage.getItem(key('stale'))).toBe(null)
    expect(localStorage.getItem(key('corrupt'))).toBe(null)
  })

  it('prune leaves entries under other prefixes untouched', () => {
    localStorage.setItem('hydra-other-key', 'keep me')
    store.save(key('stale'), { count: 1 })
    vi.advanceTimersByTime(TTL + 1)
    store.prune()
    expect(localStorage.getItem('hydra-other-key')).toBe('keep me')
  })

  it('prune skips a configured skipPrefix even when it shares the prefix', () => {
    const SKIP = `${PREFIX}sub-`
    const skipStore = createShardedStore<Prefs>(PREFIX, TTL, { skipPrefix: SKIP })
    // A differently-shaped sibling entry (no timestamp) under the skip prefix.
    localStorage.setItem(`${SKIP}x`, JSON.stringify({ anything: true }))
    skipStore.save(key('stale'), { count: 1 })
    vi.advanceTimersByTime(TTL + 1)
    skipStore.prune()
    expect(localStorage.getItem(`${SKIP}x`)).toBe(JSON.stringify({ anything: true }))
    expect(localStorage.getItem(key('stale'))).toBe(null)
  })
})
