import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SPAWN_ROWS,
  MIN_SPAWN_ROWS,
  MAX_SPAWN_ROWS,
  loadLastGeometry,
  saveLastGeometry,
  loadDefaultRows,
  spawnGeometry,
} from './terminalGeometry'
import { StorageKeys, writeLocal } from './storage'

describe('constants', () => {
  it('has sane guardrails', () => {
    expect(MIN_SPAWN_ROWS).toBeLessThan(MAX_SPAWN_ROWS)
    expect(DEFAULT_SPAWN_ROWS).toBeGreaterThanOrEqual(MIN_SPAWN_ROWS)
    expect(DEFAULT_SPAWN_ROWS).toBeLessThanOrEqual(MAX_SPAWN_ROWS)
  })
})

describe('loadLastGeometry / saveLastGeometry', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when nothing stored', () => {
    expect(loadLastGeometry()).toBe(null)
  })

  it('round-trips a saved geometry', () => {
    saveLastGeometry(120, 40)
    expect(loadLastGeometry()).toEqual({ cols: 120, rows: 40 })
  })

  it('returns null for malformed JSON', () => {
    writeLocal(StorageKeys.terminalGeometry, '{not json')
    expect(loadLastGeometry()).toBe(null)
  })

  it('rejects non-numeric fields', () => {
    writeLocal(StorageKeys.terminalGeometry, JSON.stringify({ cols: '80', rows: 24 }))
    expect(loadLastGeometry()).toBe(null)
  })

  it('rejects non-positive dimensions', () => {
    writeLocal(StorageKeys.terminalGeometry, JSON.stringify({ cols: 0, rows: 24 }))
    expect(loadLastGeometry()).toBe(null)
    writeLocal(StorageKeys.terminalGeometry, JSON.stringify({ cols: 80, rows: -1 }))
    expect(loadLastGeometry()).toBe(null)
  })
})

describe('loadDefaultRows', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when unset', () => {
    expect(loadDefaultRows()).toBe(null)
  })

  it('returns null for a non-numeric stored value', () => {
    writeLocal(StorageKeys.terminalDefaultRows, 'abc')
    expect(loadDefaultRows()).toBe(null)
  })

  it('returns null for a non-positive stored value', () => {
    writeLocal(StorageKeys.terminalDefaultRows, '0')
    expect(loadDefaultRows()).toBe(null)
    writeLocal(StorageKeys.terminalDefaultRows, '-5')
    expect(loadDefaultRows()).toBe(null)
  })

  it('returns an in-range value unchanged', () => {
    writeLocal(StorageKeys.terminalDefaultRows, '30')
    expect(loadDefaultRows()).toBe(30)
  })

  it('clamps below MIN up to MIN', () => {
    writeLocal(StorageKeys.terminalDefaultRows, String(MIN_SPAWN_ROWS - 1))
    expect(loadDefaultRows()).toBe(MIN_SPAWN_ROWS)
  })

  it('clamps above MAX down to MAX', () => {
    writeLocal(StorageKeys.terminalDefaultRows, String(MAX_SPAWN_ROWS + 100))
    expect(loadDefaultRows()).toBe(MAX_SPAWN_ROWS)
  })

  it('parses a value with trailing non-digits via parseInt', () => {
    writeLocal(StorageKeys.terminalDefaultRows, '50px')
    expect(loadDefaultRows()).toBe(50)
  })
})

describe('spawnGeometry', () => {
  beforeEach(() => localStorage.clear())

  it('falls back to DEFAULT_SPAWN_ROWS with no width when nothing stored', () => {
    expect(spawnGeometry()).toEqual({ rows: DEFAULT_SPAWN_ROWS })
  })

  it('prefers last geometry (both cols and rows) when present', () => {
    saveLastGeometry(150, 60)
    expect(spawnGeometry()).toEqual({ cols: 150, rows: 60 })
  })

  it('uses the configured default rows (no cols) when only that is set', () => {
    writeLocal(StorageKeys.terminalDefaultRows, '42')
    expect(spawnGeometry()).toEqual({ rows: 42 })
  })

  it('last-geometry rows win over the configured default', () => {
    writeLocal(StorageKeys.terminalDefaultRows, '42')
    saveLastGeometry(100, 70)
    expect(spawnGeometry()).toEqual({ cols: 100, rows: 70 })
  })
})
