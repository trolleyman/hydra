import { Check, Copy, X } from 'lucide-react'
import type { ComponentType } from 'react'
import type { CopyState } from '../lib/useCopyFlash'

// CopyStateIcon renders a copy button's icon for the current flash state (from
// useCopyFlash): the idle Copy icon (tinted by idleColor, or inheriting the
// button's colour when idleColor is empty), a green Check on success, a red X
// on failure.
//
// `idle` swaps the idle glyph for something more specific, so two copy buttons
// sitting next to each other (the diff header's "copy path" and "copy diff")
// aren't the same icon twice. The success/failure flash stays the shared
// tick/cross - that half is about the outcome, not about what was copied.
export function CopyStateIcon({
  state,
  size = 'w-3.5 h-3.5',
  idleColor = '',
  idle: Idle = Copy,
}: {
  state: CopyState
  size?: string
  idleColor?: string
  idle?: ComponentType<{ className?: string }>
}) {
  if (state === 'ok') return <Check className={`${size} text-green-500`} />
  if (state === 'err') return <X className={`${size} text-red-500`} />
  return <Idle className={`${size} ${idleColor}`} />
}
