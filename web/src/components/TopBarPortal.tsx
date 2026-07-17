import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useTopBarSlot } from '../lib/topBarSlot'

// Renders children into the global top bar's slot (see __root.tsx). The slot
// element registers via a callback ref during __root's commit, so it is
// available by the time route content mounts; until then (one frame at worst)
// nothing renders.
export function TopBarPortal({ children }: { children: ReactNode }) {
  const el = useTopBarSlot((s) => s.el)
  return el ? createPortal(children, el) : null
}
