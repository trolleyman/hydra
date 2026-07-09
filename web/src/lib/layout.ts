import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// The two-pane split only applies at lg+ (the sidebar's own breakpoint). Below
// it the agent page degrades to the classic single-column stacked layout, which
// is already responsive and reads well on a phone.
export const SPLIT_QUERY = '(min-width: 1024px)'

// Small matchMedia hook (mirrors useFinePointer) - re-renders on breakpoint
// crossings so the layout can swap between split and stacked live.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

// Agent-page layout state: the split-layout feature flag and the pane-collapse
// focus mode. Both are browser-scoped, global preferences (like the sidebar
// store) so any surface - notably AgentTopBar, which hosts the inspector toggle
// - can read and flip them without prop-drilling.

// ── Split-layout feature flag ────────────────────────────────────────────────
// The new two-pane agent layout (working pane + inspector pane). Default ON; a
// Settings > Browser toggle lets the user fall back to the classic single-scroll
// stacked layout while it beds in. Stored as '0' when opted out; absent/'1' = on.
export function loadSplitLayoutEnabled(): boolean {
  return readLocal(StorageKeys.splitLayoutEnabled) !== '0'
}

interface SplitLayoutState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useSplitLayoutStore = create<SplitLayoutState>()(
  persist(
    (set) => ({
      enabled: loadSplitLayoutEnabled(),
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: StorageKeys.splitLayoutEnabled,
      storage: singleFieldStorage('enabled', loadSplitLayoutEnabled, (enabled) =>
        writeLocal(StorageKeys.splitLayoutEnabled, enabled ? null : '0'),
      ),
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
)

// ── Pane collapse (focus mode) ───────────────────────────────────────────────
// The divider has three states: the normal split, terminal-only (inspector
// collapsed) and inspector-only (working pane collapsed). Persisted globally so
// a focus choice survives navigation and reload, like the sidebar collapse.
export type PaneCollapse = 'none' | 'inspector' | 'working'

function loadPaneCollapse(): PaneCollapse {
  const v = readLocal(StorageKeys.agentPaneCollapse)
  return v === 'inspector' || v === 'working' ? v : 'none'
}

interface PaneCollapseState {
  collapse: PaneCollapse
  setCollapse: (c: PaneCollapse) => void
  // Toggle a pane hidden/shown. Hiding one pane implicitly reveals the other, so
  // at most one pane is ever collapsed.
  toggleInspector: () => void
  toggleWorking: () => void
}

export const usePaneCollapseStore = create<PaneCollapseState>()(
  persist(
    (set, get) => ({
      collapse: loadPaneCollapse(),
      setCollapse: (collapse) => set({ collapse }),
      toggleInspector: () => set({ collapse: get().collapse === 'inspector' ? 'none' : 'inspector' }),
      toggleWorking: () => set({ collapse: get().collapse === 'working' ? 'none' : 'working' }),
    }),
    {
      name: StorageKeys.agentPaneCollapse,
      storage: singleFieldStorage('collapse', loadPaneCollapse, (c) =>
        writeLocal(StorageKeys.agentPaneCollapse, c === 'none' ? null : c),
      ),
      partialize: (s) => ({ collapse: s.collapse }),
    },
  ),
)

// ── Split ratio ──────────────────────────────────────────────────────────────
// The left (working) pane's share of the width, a fraction in [MIN, MAX].
// Default 0.4 (40% terminal / 60% inspector - decision #5: the diff needs the
// room, chat reads fine at 40%). Read/written as a bare float string, mirroring
// sidebarWidth (plain useState in AgentDetail rather than a store, since only the
// agent page reads it).
export const SPLIT_RATIO_DEFAULT = 0.4
export const SPLIT_RATIO_MIN = 0.2
export const SPLIT_RATIO_MAX = 0.8

export function loadSplitRatio(): number {
  const raw = readLocal(StorageKeys.agentSplitRatio)
  if (raw == null) return SPLIT_RATIO_DEFAULT
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return SPLIT_RATIO_DEFAULT
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, n))
}

export function saveSplitRatio(ratio: number): void {
  writeLocal(StorageKeys.agentSplitRatio, String(ratio))
}
