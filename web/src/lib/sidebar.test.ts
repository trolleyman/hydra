import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSidebarStore } from './sidebar'
import { StorageKeys, readLocal } from './storage'

// The store keeps two independent flags: the persisted desktop collapse
// preference and the transient mobile panel state. The global matchMedia stub
// (see test setup) never matches, so by default tests run on the "mobile" side;
// desktop-side cases override matchMedia per test.

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

describe('useSidebarStore', () => {
  beforeEach(() => {
    localStorage.clear()
    stubMatchMedia(false)
    // Re-read after clearing so each case starts from "nothing stored".
    useSidebarStore.persist.rehydrate()
    useSidebarStore.getState().closeMobile()
  })

  afterEach(() => {
    stubMatchMedia(false)
  })

  it('defaults to desktop expanded and mobile closed when nothing is stored', () => {
    expect(useSidebarStore.getState().desktopCollapsed).toBe(false)
    expect(useSidebarStore.getState().mobileOpen).toBe(false)
  })

  it('rehydrates only an explicit stored "1" as collapsed', () => {
    localStorage.setItem(StorageKeys.sidebarCollapsed, '1')
    useSidebarStore.persist.rehydrate()
    expect(useSidebarStore.getState().desktopCollapsed).toBe(true)

    // The old store's '0' ("explicitly expanded") migrates to expanded.
    localStorage.setItem(StorageKeys.sidebarCollapsed, '0')
    useSidebarStore.persist.rehydrate()
    expect(useSidebarStore.getState().desktopCollapsed).toBe(false)
  })

  it('never rehydrates the mobile panel open', () => {
    useSidebarStore.getState().openMobile()
    localStorage.setItem(StorageKeys.sidebarCollapsed, '1')
    useSidebarStore.persist.rehydrate()
    expect(useSidebarStore.getState().mobileOpen).toBe(false)
  })

  it('toggle on mobile flips mobileOpen and persists nothing', () => {
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().mobileOpen).toBe(true)
    expect(useSidebarStore.getState().desktopCollapsed).toBe(false)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe(null)

    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().mobileOpen).toBe(false)
  })

  it('toggle on desktop flips and persists desktopCollapsed, leaving mobileOpen alone', () => {
    stubMatchMedia(true)
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().desktopCollapsed).toBe(true)
    expect(useSidebarStore.getState().mobileOpen).toBe(false)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe('1')

    // Expanding again clears the key (expanded is the default).
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().desktopCollapsed).toBe(false)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe(null)
  })

  it('desktop collapse preference survives a mobile open/close cycle', () => {
    stubMatchMedia(true)
    useSidebarStore.getState().toggle() // collapse on desktop
    stubMatchMedia(false)
    useSidebarStore.getState().openMobile()
    useSidebarStore.getState().closeMobile()
    expect(useSidebarStore.getState().desktopCollapsed).toBe(true)
    expect(readLocal(StorageKeys.sidebarCollapsed)).toBe('1')
  })
})
