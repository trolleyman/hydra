import { useEffect } from 'react'

// WebKitGTK can composite native scrollbar chrome above a fixed overlay even
// when the overlay has the higher z-index. Track every modal overlay together:
// a confirmation dialog can open over the file lightbox, and closing either one
// must not reveal the underlying scrollbar while the other remains mounted.
let openOverlayCount = 0

export function useOverlayScrollbarSuppression(active = true) {
  useEffect(() => {
    if (!active) return

    openOverlayCount += 1
    document.documentElement.classList.add('hydra-overlay-open')

    return () => {
      openOverlayCount = Math.max(0, openOverlayCount - 1)
      if (openOverlayCount === 0) {
        document.documentElement.classList.remove('hydra-overlay-open')
      }
    }
  }, [active])
}
