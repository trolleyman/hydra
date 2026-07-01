import { useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '../api'
import { useSidebarStore } from './sidebar'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { isTypingTarget } from './shortcuts'

// useGlobalShortcuts owns the app-wide keyboard handling that used to live in
// three separate effects in RootLayout:
//   - Ctrl/Cmd + .  toggles the sidebar (treated as an explicit toggle → persists)
//   - ?             toggles the keyboard-shortcuts help overlay (unless typing)
//   - Ctrl + `      alt-tab-style project switcher (Shift reverses)
// They share a single keydown listener now; the keys are distinct so the branches
// don't interfere. Returns the switcher's highlight index, which the caller feeds
// to ProjectDropdown via `keyboardIndex` (the switcher reuses the real selector UI
// rather than a separate overlay).
export function useGlobalShortcuts({
  projects,
  currentProjectId,
  selectProject,
}: {
  projects: ProjectInfo[]
  currentProjectId: string | null
  selectProject: (id: string) => void
}): number | null {
  // Alt-tab-style project switcher: while Ctrl is held, each Ctrl+` press steps
  // the highlight through this overlay (Shift reverses); releasing Ctrl commits.
  // `null` = overlay closed; otherwise the highlighted index into `projects`.
  const [switcherIndex, setSwitcherIndex] = useState<number | null>(null)

  // The switcher commits on Ctrl-up using the latest projects/selection/handler;
  // read them through refs so the listeners stay stable (bound once) and never
  // re-bind on every render.
  const selectProjectRef = useRef(selectProject)
  const projectsRef = useRef(projects)
  const currentProjectIdRef = useRef(currentProjectId)
  const switcherIndexRef = useRef(switcherIndex)
  // Keep the mirrors fresh in an effect (not during render — the listeners only
  // read them later, from keydown/Ctrl-up, so post-commit is soon enough).
  useEffect(() => {
    selectProjectRef.current = selectProject
    projectsRef.current = projects
    currentProjectIdRef.current = currentProjectId
    switcherIndexRef.current = switcherIndex
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

      // `?` toggles the keyboard-shortcuts help overlay — except while typing (a
      // terminal, a form field), where `?` is just a character. No modifier so
      // it's as quick to reach as a real cheat-sheet key.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTypingTarget(e.target)) return
        e.preventDefault()
        useShortcutsStore.getState().toggle()
        return
      }

      // Project switcher. Escape cancels; Ctrl+` (e.code === 'Backquote' so it's
      // keyboard-layout independent — Shift+` is '~' on US layouts) steps the
      // highlight, Shift+` steps back (both wrap). We reveal the sidebar first
      // (transient, non-persisted) so the dropdown is on screen when collapsed.
      if (e.key === 'Escape') {
        setSwitcherIndex(null) // no-op (React bails) if already closed
        return
      }
      if (e.code !== 'Backquote' || !e.ctrlKey || e.altKey || e.metaKey) return
      const list = projectsRef.current
      if (list.length < 2) return
      e.preventDefault()
      if (e.repeat) return // one step per physical press, not per auto-repeat
      if (switcherIndexRef.current === null) useSidebarStore.getState().setCollapsed(false, false)
      const dir = e.shiftKey ? -1 : 1
      setSwitcherIndex((cur) => {
        // First press steps off the current project; later presses step off the
        // current highlight. With nothing selected, land on first/last.
        const base = cur ?? list.findIndex((p) => p.id === currentProjectIdRef.current)
        const start = base === -1 ? (dir === 1 ? -1 : 0) : base
        return (start + dir + list.length) % list.length
      })
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== 'Control') return
      const cur = switcherIndexRef.current
      if (cur === null) return
      setSwitcherIndex(null)
      const proj = projectsRef.current[cur]
      if (proj && proj.id !== currentProjectIdRef.current) selectProjectRef.current(proj.id)
    }
    function onBlur() { setSwitcherIndex(null) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return switcherIndex
}
