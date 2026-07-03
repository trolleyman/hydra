import { useEffect, useState } from 'react'

// True when the primary input is a precise pointer with hover (a mouse/trackpad)
// - i.e. a device that has a physical keyboard worth showing shortcut hints for.
// Touch phones/tablets report coarse pointer + no hover, where keyboard hints are
// noise. Reactive so it follows a 2-in-1 switching between laptop and tablet mode.
const QUERY = '(hover: hover) and (pointer: fine)'

export function useFinePointer(): boolean {
  const [fine, setFine] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(QUERY)
    const onChange = () => setFine(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return fine
}
