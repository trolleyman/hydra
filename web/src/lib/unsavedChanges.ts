import { useEffect } from 'react'
import { useBlocker } from '@tanstack/react-router'

// useUnsavedChangesGuard wires up what a page holding an unsaved draft needs -
// the in-app navigation blocker and the browser's tab-close warning - so both
// settings pages state it once instead of repeating the pair. Pass whether the
// page currently has unsaved changes.
//
// Only user-driven navigation should ever reach this: code that navigates on
// the user's behalf (the sidebar spawn) stays put unless it is on a page with
// nothing to lose, so the confirm never arrives as a surprise.
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
    const handleBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])
}
