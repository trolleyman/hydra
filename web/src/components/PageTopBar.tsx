import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { IconButton } from './IconButton'

// A lightweight header bar for pages that need a title plus page-level actions
// (settings: back arrow + save). The show-sidebar toggle now lives in the
// global top bar (__root), so this bar is pure page content.
export function PageTopBar({ title, right, onBack }: { title: string; right?: ReactNode; onBack?: () => void }) {
  return (
    <div className="shrink-0 h-12 px-3 sm:px-4 flex items-center gap-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Back arrow - only shown when there's somewhere to return to (we arrived
          here from another page rather than landing on it directly). */}
      {onBack && (
        <Tooltip content="Back">
          <IconButton variant="panel" aria-label="Back" onClick={onBack} className="shrink-0 -ml-1">
            <ChevronLeft className="w-5 h-5" />
          </IconButton>
        </Tooltip>
      )}
      <span className="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</span>
      {right && <div className="ml-auto shrink-0">{right}</div>}
    </div>
  )
}
