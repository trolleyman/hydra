import { describe, it, expect, beforeEach } from 'vitest'
import { loadThemeMode } from './theme'
import { StorageKeys } from './storage'

describe('loadThemeMode', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to system when nothing is stored', () => {
    expect(loadThemeMode()).toBe('system')
  })

  it.each(['light', 'dark', 'system'] as const)('loads the stored %s mode', (mode) => {
    localStorage.setItem(StorageKeys.themeMode, mode)
    expect(loadThemeMode()).toBe(mode)
  })

  it('defaults to system for a garbage stored value', () => {
    localStorage.setItem(StorageKeys.themeMode, 'chartreuse')
    expect(loadThemeMode()).toBe('system')
  })

  // Regression guard for PLAN #64c: the legacy boolean `hydra-dark-mode` key used
  // to be migrated into a theme mode on first read. That migration window has
  // passed and the code is gone, so a lingering legacy key must now be ignored —
  // the preference falls through to the `system` default instead of resurrecting
  // the old light/dark choice.
  it('ignores the legacy hydra-dark-mode key', () => {
    localStorage.setItem('hydra-dark-mode', 'true')
    expect(loadThemeMode()).toBe('system')
  })

  it('a valid themeMode still wins even if the legacy key is present', () => {
    localStorage.setItem('hydra-dark-mode', 'true')
    localStorage.setItem(StorageKeys.themeMode, 'light')
    expect(loadThemeMode()).toBe('light')
  })
})
