import { create } from 'zustand'
import { StorageKeys, readLocal, writeLocal } from './storage'

// Shared collapse state for the app sidebar. It lives in a store (rather than
// local state in __root) so other surfaces — e.g. the agent page's sticky top
// bar, which hosts the "show sidebar" toggle when collapsed — can read and flip
// it without prop-drilling through the router.

// Below this width the sidebar is an off-canvas overlay; at/above it it's the
// usual in-flow column. Matches Tailwind's `lg` breakpoint (see __root.tsx).
export const SIDEBAR_OVERLAY_QUERY = '(min-width: 1024px)'

function initialCollapsed(): boolean {
  const saved = readLocal(StorageKeys.sidebarCollapsed)
  if (saved === '1') return true
  if (saved === '0') return false
  // No stored preference: collapsed on small screens (an open overlay over the
  // content is a poor default), expanded on wide ones.
  return typeof window !== 'undefined' && !window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches
}

interface SidebarState {
  collapsed: boolean
  // persist=true writes the choice to localStorage (explicit user intent);
  // transient changes (e.g. the small-screen auto-close on navigation) pass
  // false so they don't clobber the wide-screen preference.
  setCollapsed: (collapsed: boolean, persist?: boolean) => void
  toggle: () => void
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: initialCollapsed(),
  setCollapsed: (collapsed, persist = false) => {
    if (persist) writeLocal(StorageKeys.sidebarCollapsed, collapsed ? '1' : '0')
    set({ collapsed })
  },
  toggle: () => {
    const next = !get().collapsed
    writeLocal(StorageKeys.sidebarCollapsed, next ? '1' : '0')
    set({ collapsed: next })
  },
}))
