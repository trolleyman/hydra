import type { ReactNode } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { useSidebarStore } from '../lib/sidebar'
import { Tooltip } from './Tooltip'

// A lightweight header bar for pages that already have their own internal header
// (the repository browser, settings) but need somewhere to host the show-sidebar
// toggle — and a bit of context — while the sidebar is collapsed. It renders
// nothing when the sidebar is open (the sidebar itself provides the context and
// the toggle), so it only appears on small screens / when hidden.
export function PageTopBar({ title, right }: { title: string; right?: ReactNode }) {
  const collapsed = useSidebarStore((s) => s.collapsed)
  const toggle = useSidebarStore((s) => s.toggle)
  if (!collapsed) return null
  return (
    <div className="shrink-0 h-12 px-3 sm:px-4 flex items-center gap-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <Tooltip content="Show sidebar (Ctrl+.)">
        <button
          type="button"
          aria-label="Show sidebar"
          onClick={toggle}
          className="shrink-0 -ml-1 w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>
      </Tooltip>
      <span className="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</span>
      {right && <div className="ml-auto shrink-0">{right}</div>}
    </div>
  )
}
