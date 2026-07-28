import { useEffect } from 'react'
import { useBlocker } from '@tanstack/react-router'

// A page holding an unsaved draft (both settings pages) guards navigation with a
// confirm and registers itself here while it is dirty, so code that navigates on
// the user's behalf - rather than because they clicked a link - can check first
// and stay put instead of springing a "discard your changes?" prompt on them.
//
// A plain module-level count, not a store: nothing re-renders on it, and the one
// reader (spawn) samples it once at click time.
let dirtyPages = 0

export function hasUnsavedWork(): boolean {
  return dirtyPages > 0
}

// useUnsavedChangesGuard wires up the three things a page with a draft needs:
// the in-app navigation blocker, the browser's tab-close warning, and the
// registration above. Pass whether the page currently has unsaved changes.
export function useUnsavedChangesGuard(hasUnsavedChanges: boolean) {
  useBlocker({
    shouldBlockFn: () => {
      if (hasUnsavedChanges) {
        return !window.confirm('You have unsaved changes. Discard them?')
      }
      return false
    },
    enableBeforeUnload: true,
  })

  useEffect(() => {
    if (!hasUnsavedChanges) return
    dirtyPages++
    const handleBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      dirtyPages--
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [hasUnsavedChanges])
}
