import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// Shared visibility state for the app sidebar. It lives in a store (rather than
// local state in __root) so other surfaces - e.g. the global top bar, which
// hosts the "show sidebar" toggle - can read and flip it without prop-drilling
// through the router.

// Below this width the sidebar is a full-screen panel; at/above it it's the
// usual in-flow column. Matches Tailwind's `md` breakpoint (see __root.tsx) -
// unified with the agent-page split and RepositoryView so every surface flips
// to its mobile layout at the same width.
export const SIDEBAR_DESKTOP_QUERY = '(min-width: 768px)'

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches
}

// The persisted desktop collapse preference. Stored raw as '1'/'0' under the
// pre-existing sidebarCollapsed key ('1' = collapsed); absent = expanded, the
// desktop default. (The old store persisted a nullable tri-state under the same
// key, so old values migrate cleanly: only an explicit '1' starts collapsed.)
function loadDesktopCollapsed(): boolean {
  return readLocal(StorageKeys.sidebarCollapsed) === '1'
}

// The desktop and mobile sides are deliberately independent flags: crossing the
// breakpoint (resizing a window onto a phone-sized viewport) must never pop the
// sidebar open, so the mobile panel has its own transient open flag that starts
// closed and is only ever set by an explicit toggle - never by rehydration or
// the desktop preference.
interface SidebarState {
  // Persisted desktop preference: the in-flow column is collapsed.
  desktopCollapsed: boolean
  // Transient mobile state: the full-screen panel is open. Never persisted.
  mobileOpen: boolean
  setDesktopCollapsed: (collapsed: boolean) => void
  openMobile: () => void
  closeMobile: () => void
  // Flip the flag for the breakpoint the window is currently on.
  toggle: () => void
}

// persist owns the write-on-set (it persists `desktopCollapsed` whenever it
// changes) and the read-on-init. singleFieldStorage keeps the stored value as
// the bare '1'/'0' under the existing key; `mobileOpen` is never persisted.
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      desktopCollapsed: loadDesktopCollapsed(),
      mobileOpen: false,
      setDesktopCollapsed: (desktopCollapsed) => set({ desktopCollapsed }),
      openMobile: () => set({ mobileOpen: true }),
      closeMobile: () => set({ mobileOpen: false }),
      toggle: () =>
        isDesktop()
          ? set({ desktopCollapsed: !get().desktopCollapsed })
          : set({ mobileOpen: !get().mobileOpen }),
    }),
    {
      name: StorageKeys.sidebarCollapsed,
      storage: singleFieldStorage('desktopCollapsed', loadDesktopCollapsed, (c) =>
        writeLocal(StorageKeys.sidebarCollapsed, c ? '1' : null),
      ),
      partialize: (s) => ({ desktopCollapsed: s.desktopCollapsed }),
      // Rehydration restores only the desktop preference; the mobile panel
      // always boots closed.
      merge: (persisted, current) => ({
        ...current,
        desktopCollapsed:
          (persisted as { desktopCollapsed?: boolean } | undefined)?.desktopCollapsed ?? false,
        mobileOpen: false,
      }),
    },
  ),
)
