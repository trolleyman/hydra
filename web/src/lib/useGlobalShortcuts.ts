import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '../api'
import { useSidebarStore } from './sidebar'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { isTypingTarget } from './shortcuts'
import { recencyOrder } from './projectRecency'

// The live state of the Ctrl+` project switcher: the ordered list snapshot taken
// when it opened (most-recently-visited first) and the currently highlighted
// index. null means the switcher is closed.
export interface SwitcherState {
  items: ProjectInfo[]
  index: number
}

// useGlobalShortcuts owns the app-wide keyboard handling:
//   - Ctrl/Cmd + .  toggles the sidebar (treated as an explicit toggle -> persists)
//   - ?             toggles the keyboard-shortcuts help overlay (unless typing)
//   - Ctrl + `      alt-tab-style project switcher (Shift reverses)
// They share a single keydown listener; the keys are distinct so the branches
// don't interfere. The switcher works like a window switcher: while Ctrl is held,
// each Ctrl+` press steps the highlight through a centered overlay (ProjectSwitcher)
// whose list is ordered by last-visited, and releasing Ctrl commits the highlight.
// Returns the switcher state (null when closed) plus mouse handlers so the
// overlay's rows can be hovered (moves the highlight) and clicked (commits),
// mirroring the keyboard cycle-and-release flow.
export interface Switcher {
  state: SwitcherState | null
  // Move the highlight to a row (hover). No-op while the switcher is closed.
  setIndex: (i: number) => void
  // Commit a project by id (click), matching the Ctrl-up behaviour.
  commit: (id: string) => void
}
export function useGlobalShortcuts({
  projects,
  currentProjectId,
  selectProject,
}: {
  projects: ProjectInfo[]
  currentProjectId: string | null
  selectProject: (id: string) => void
}): Switcher {
  const [switcher, setSwitcher] = useState<SwitcherState | null>(null)

  // The switcher commits on Ctrl-up using the latest projects/selection/handler;
  // read them through refs so the listeners stay stable (bound once) and never
  // re-bind on every render.
  const selectProjectRef = useRef(selectProject)
  const projectsRef = useRef(projects)
  const currentProjectIdRef = useRef(currentProjectId)
  const switcherRef = useRef(switcher)
  useEffect(() => {
    selectProjectRef.current = selectProject
    projectsRef.current = projects
    currentProjectIdRef.current = currentProjectId
    switcherRef.current = switcher
  })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl/Cmd + . collapses or expands the sidebar from anywhere (mirrors the
      // collapse button). Treated as an explicit toggle, so it persists.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === '.') {
        e.preventDefault()
        useSidebarStore.getState().toggle()
        return
      }

      // `?` toggles the keyboard-shortcuts help overlay - except while typing (a
      // terminal, a form field), where `?` is just a character. No modifier so
      // it's as quick to reach as a real cheat-sheet key.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTypingTarget(e.target)) return
        e.preventDefault()
        useShortcutsStore.getState().toggle()
        return
      }

      // Escape cancels the switcher (React bails if it's already closed).
      if (e.key === 'Escape') {
        setSwitcher(null)
        return
      }

      // Project switcher. Ctrl+` (e.code === 'Backquote' so it's keyboard-layout
      // independent - Shift+` is '~' on US layouts) steps the highlight forward,
      // Shift+` steps back (both wrap). The list is snapshotted in last-visited
      // order on the first press so it doesn't reshuffle mid-cycle; since the
      // current project sits at the front, the first tap lands on the previous one.
      if (e.code !== 'Backquote' || !e.ctrlKey || e.altKey || e.metaKey) return
      const list = projectsRef.current
      if (list.length < 2) return
      e.preventDefault()
      if (e.repeat) return // one step per physical press, not per auto-repeat
      const dir = e.shiftKey ? -1 : 1
      setSwitcher((cur) => {
        if (cur === null) {
          const items = recencyOrder(list)
          const start = dir === 1 ? 1 : items.length - 1
          return { items, index: ((start % items.length) + items.length) % items.length }
        }
        return { items: cur.items, index: (cur.index + dir + cur.items.length) % cur.items.length }
      })
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== 'Control') return
      const cur = switcherRef.current
      if (cur === null) return
      setSwitcher(null)
      const proj = cur.items[cur.index]
      if (proj && proj.id !== currentProjectIdRef.current) selectProjectRef.current(proj.id)
    }
    function onBlur() { setSwitcher(null) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Hover moves the highlight; the shared `index` keeps keyboard and mouse in sync.
  const setIndex = useCallback((i: number) => {
    setSwitcher((cur) => (cur ? { items: cur.items, index: i } : cur))
  }, [])

  // Click commits a project, closing the switcher - same rule as the Ctrl-up path.
  const commit = useCallback((id: string) => {
    setSwitcher(null)
    if (id !== currentProjectIdRef.current) selectProjectRef.current(id)
  }, [])

  return { state: switcher, setIndex, commit }
}
