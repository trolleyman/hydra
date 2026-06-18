import { useEffect, useState } from 'react'

// usePageActive reports whether the user actually has this page in front of
// them: the tab is the foreground tab (not hidden behind another tab or
// minimised) AND the browser window holds OS focus. We treat "active" strictly
// — a visible-but-unfocused tab (another app on top) is NOT active — so that
// background activity (like an agent finishing) is not silently dismissed just
// because its page happens to be the last one that was open.
function computeActive(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function usePageActive(): boolean {
  const [active, setActive] = useState(computeActive)

  useEffect(() => {
    const update = () => setActive(computeActive())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    // Sync once on mount in case state changed before listeners attached.
    update()
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  return active
}
