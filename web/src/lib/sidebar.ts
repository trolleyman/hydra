import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// Shared collapse state for the app sidebar. It lives in a store (rather than
// local state in __root) so other surfaces - e.g. the agent page's sticky top
// bar, which hosts the "show sidebar" toggle when collapsed - can read and flip
// it without prop-drilling through the router.

// Below this width the sidebar is an off-canvas overlay; at/above it it's the
// usual in-flow column. Matches Tailwind's `lg` breakpoint (see __root.tsx).
export const SIDEBAR_OVERLAY_QUERY = '(min-width: 1024px)'

// Default when the user has never made an explicit choice: collapsed on small
// screens (an open overlay over the content is a poor default), expanded on wide
// ones.
function screenDefaultCollapsed(): boolean {
  return typeof window !== 'undefined' && !window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches
}

// The explicit collapse preference, or null when the user has never set one (so
// the screen-width default applies). Stored raw as '1'/'0' under sidebarCollapsed.
function loadCollapsePreference(): boolean | null {
  const saved = readLocal(StorageKeys.sidebarCollapsed)
  if (saved === '1') return true
  if (saved === '0') return false
  return null
}

interface SidebarState {
  // Live runtime state - what the UI actually shows. NOT persisted directly.
  collapsed: boolean
  // The explicit user choice that IS persisted; null = follow the screen default.
  preference: boolean | null
  // persist=true records the choice as the explicit preference (user intent);
  // transient changes (e.g. the small-screen auto-close on navigation) pass false
  // so they move `collapsed` without touching `preference` - and so can't clobber
  // the wide-screen preference.
  setCollapsed: (collapsed: boolean, persist?: boolean) => void
  toggle: () => void
}

// persist owns the write-on-set (it persists `preference` whenever it changes)
// and the read-on-init (its storage adapter reads the raw preference, and merge
// derives the initial `collapsed` from it). singleFieldStorage keeps the stored
// value as the bare '1'/'0' under the existing key. Only `preference` is
// persisted; `collapsed` is transient runtime state.
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      collapsed: screenDefaultCollapsed(),
      preference: null,
      setCollapsed: (collapsed, persist = false) =>
        set(persist ? { collapsed, preference: collapsed } : { collapsed }),
      toggle: () => {
        const next = !get().collapsed
        set({ collapsed: next, preference: next })
      },
    }),
    {
      name: StorageKeys.sidebarCollapsed,
      storage: singleFieldStorage('preference', loadCollapsePreference, (p) =>
        writeLocal(StorageKeys.sidebarCollapsed, p == null ? null : p ? '1' : '0'),
      ),
      partialize: (s) => ({ preference: s.preference }),
      // Derive the live collapsed flag from the persisted preference, falling back
      // to the screen-width default when the user has never made an explicit choice.
      merge: (persisted, current) => {
        const pref = (persisted as { preference?: boolean | null } | undefined)?.preference ?? null
        return { ...current, preference: pref, collapsed: pref ?? screenDefaultCollapsed() }
      },
    },
  ),
)
