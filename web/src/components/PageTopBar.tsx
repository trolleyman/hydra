import type { ReactNode } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { useSidebarStore } from '../lib/sidebar'
import { Tooltip } from './Tooltip'
import { IconButton } from './IconButton'

// A lightweight header bar for pages that already have their own internal header
// (the repository browser, settings) but need somewhere to host the show-sidebar
// toggle — and a bit of context — while the sidebar is collapsed. It renders
// nothing when the sidebar is open (the sidebar itself provides the context and
// the toggle), so it only appears on small screens / when hidden.
export function PageTopBar({ title, right, always }: { title: string; right?: ReactNode; always?: boolean }) {
  const collapsed = useSidebarStore((s) => s.collapsed)
  const toggle = useSidebarStore((s) => s.toggle)
  if (!collapsed && !always) return null
  return (
    <div className="shrink-0 h-12 px-3 sm:px-4 flex items-center gap-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* The toggle only makes sense when the sidebar is hidden; with `always`
          the bar still shows on desktop (for its title + actions) but no toggle. */}
      {collapsed && (
        <Tooltip content="Show sidebar (Ctrl+.)">
          <IconButton variant="panel" aria-label="Show sidebar" onClick={toggle} className="shrink-0 -ml-1">
            <PanelLeftOpen className="w-5 h-5" />
          </IconButton>
        </Tooltip>
      )}
      <span className="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</span>
      {right && <div className="ml-auto shrink-0">{right}</div>}
    </div>
  )
}
