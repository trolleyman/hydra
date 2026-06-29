import { describe, it, expect, beforeEach } from 'vitest'
import { useSidebarStore } from './sidebar'
import { StorageKeys, readLocal } from './storage'

// The sidebar store adopts zustand persist but distinguishes the persisted
// explicit `preference` from the transient runtime `collapsed` flag. matchMedia
// is stubbed to never match (see test setup), so the screen-width default is
// "collapsed" (small-screen behaviour).
describe('useSidebarStore persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    // Re-read after clearing so each case starts from "no stored preference".
    useSidebarStore.persist.rehydrate()
  })

  it('falls back to the screen-width default when nothing is stored', () => {
    expect(useSidebarStore.getState().preference).toBe(null)
    expect(useSidebarStore.getState().collapsed).toBe(true)
  })

  it('toggle records and persists the explicit preference', () => {
    const before = useSidebarStore.getState().collapsed
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().collapsed).toBe(!before)
    expect(useSidebarStore.getState().preference).toBe(!before)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe(!before ? '1' : '0')
  })

  it('a transient change moves collapsed but does not clobber the preference', () => {
    // User explicitly expands (e.g. on a wide screen).
    useSidebarStore.getState().setCollapsed(false, true)
    expect(useSidebarStore.getState().preference).toBe(false)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe('0')

    // A transient small-screen auto-close flips the live flag only.
    useSidebarStore.getState().setCollapsed(true, false)
    expect(useSidebarStore.getState().collapsed).toBe(true)
    expect(useSidebarStore.getState().preference).toBe(false)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe('0')
  })

  it('rehydrates the live collapsed flag from a stored preference', () => {
    localStorage.setItem(StorageKeys.sidebarCollapsed, '0')
    useSidebarStore.persist.rehydrate()
    expect(useSidebarStore.getState().preference).toBe(false)
    expect(useSidebarStore.getState().collapsed).toBe(false)

    localStorage.setItem(StorageKeys.sidebarCollapsed, '1')
    useSidebarStore.persist.rehydrate()
    expect(useSidebarStore.getState().preference).toBe(true)
    expect(useSidebarStore.getState().collapsed).toBe(true)
  })
})
