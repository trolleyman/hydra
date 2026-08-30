import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface InfoTooltipProps {
  title?: string
  children: ReactNode
  // Tooltip width in px. Defaults to 384 (the old w-96). Used for both the box
  // itself and the off-screen-clamping math, so they stay in sync.
  width?: number
  /** Accessible name for the trigger. Defaults to "<title> help" / "Help". */
  label?: string
}

// Thin preset over <Tooltip>: an Info icon trigger whose hover box holds the
// passed-in body. This preset opens immediately and pins on click/tap.
//
// The trigger is a real <button>, not a bare <svg>: it gives the 14px icon a
// 20px hit target (the icon alone was genuinely hard to land on), makes the help
// reachable by keyboard, and gives Tooltip's click-to-pin something to fire on
// so a long explainer can be read on a touch device.
export function InfoTooltip({ title, children, width = 384, label }: InfoTooltipProps) {
  return (
    <Tooltip title={title} width={width} content={children} delay={0} pin className="ml-1 align-middle">
      <button
        type="button"
        aria-label={label ?? (title ? `${title} help` : 'Help')}
        className="inline-flex items-center justify-center w-5 h-5 -m-[3px] rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  )
}
