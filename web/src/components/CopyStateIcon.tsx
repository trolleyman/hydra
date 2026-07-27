import { Check, Copy, X } from 'lucide-react'
import type { CopyState } from '../lib/useCopyFlash'

// CopyStateIcon renders a copy button's icon for the current flash state (from
// useCopyFlash): the idle Copy icon (tinted by idleColor, or inheriting the
// button's colour when idleColor is empty), a green Check on success, a red X
// on failure.
export function CopyStateIcon({
  state,
  size = 'w-3.5 h-3.5',
  idleColor = '',
}: {
  state: CopyState
  size?: string
  idleColor?: string
}) {
  if (state === 'ok') return <Check className={`${size} text-green-500`} />
  if (state === 'err') return <X className={`${size} text-red-500`} />
  return <Copy className={`${size} ${idleColor}`} />
}
