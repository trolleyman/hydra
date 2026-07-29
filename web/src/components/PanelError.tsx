import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

// PanelError is the red error box a diff-viewer panel (Previews / Tests /
// Artifacts) shows when its data fetch fails with a real server error - so a
// failure (e.g. a config.toml that won't parse) is visible instead of the panel
// silently rendering nothing. The header names which panel failed; the message
// is the server's detail, shown verbatim so it is actionable.
export function PanelError({ title, icon, message }: { title: string; icon?: ReactNode; message: string }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2 min-h-[1.625rem]">
        {icon && <span className="text-gray-500 dark:text-gray-400">{icon}</span>}
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">{title}</h3>
      </div>
      <div className="rounded-lg border border-red-300 dark:border-red-800/70 bg-red-50 dark:bg-red-900/20 px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-sm font-medium text-red-700 dark:text-red-300">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          Couldn't load {title.toLowerCase()}
        </div>
        <div className="mt-1 text-xs font-mono whitespace-pre-wrap break-words text-red-700/90 dark:text-red-300/90 max-h-40 overflow-auto">
          {message}
        </div>
      </div>
    </div>
  )
}
