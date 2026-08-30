import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface InfoTooltipProps {
  title?: string
  children: ReactNode
  /** Accessible name for the trigger. Defaults to "<title> help" / "Help". */
  label?: string
}

// Thin preset over <Tooltip>: an Info icon trigger whose hover box holds the
// passed-in body.
//
// The trigger is a real <button>, not a bare <svg>: it gives the 14px icon a
// 20px hit target (the icon alone was genuinely hard to land on), makes the help
// reachable by keyboard.
export function InfoTooltip({ title, children, label }: InfoTooltipProps) {
  return (
    <Tooltip title={title} content={children} className="ml-1 align-middle">
      <button
        type="button"
        aria-label={label ?? (title ? `${title} help` : 'Help')}
        className="inline-flex items-center justify-center w-5 h-5 -m-[3px] cursor-default rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  )
}
