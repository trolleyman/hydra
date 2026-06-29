import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface InfoTooltipProps {
  title?: string
  children: ReactNode
  // Tooltip width in px. Defaults to 384 (the old w-96). Used for both the box
  // itself and the off-screen-clamping math, so they stay in sync.
  width?: number
}

// Thin preset over <Tooltip variant="card">: an Info icon trigger whose hover
// card holds the passed-in body. All the portal/placement/show-hide logic lives
// in Tooltip.tsx — this just wires up the icon and the card defaults.
export function InfoTooltip({ title, children, width = 384 }: InfoTooltipProps) {
  return (
    <Tooltip variant="card" title={title} width={width} content={children} className="ml-1 align-middle">
      <Info className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help transition-colors" />
    </Tooltip>
  )
}
