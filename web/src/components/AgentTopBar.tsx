import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PanelLeftOpen, ChevronDown } from 'lucide-react'
import { useSidebarStore } from '../lib/sidebar'
import { Tooltip } from './Tooltip'

export interface AgentTopBarAction {
  label: string
  icon: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

// A sticky, Claude-style top bar for the agent page, shown only while the sidebar
// is collapsed (otherwise the page's own title header is visible and the sidebar
// holds the toggle). It hosts the "show sidebar" toggle on the left, the agent
// name with an actions dropdown in the middle, and a status dot on the right — so
// the reveal control never has to overlap the title.
export function AgentTopBar({
  title,
  statusDot,
  actions,
}: {
  title: string
  statusDot?: ReactNode
  actions: AgentTopBarAction[]
}) {
  const collapsed = useSidebarStore((s) => s.collapsed)
  const toggle = useSidebarStore((s) => s.toggle)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Close the menu whenever the bar is hidden (sidebar expanded).
  useEffect(() => {
    if (!collapsed) setOpen(false)
  }, [collapsed])

  if (!collapsed) return null
  const hasMenu = actions.length > 0

  return (
    // Bleed past the page padding (p-3 / sm:p-6) so the bar spans edge-to-edge and
    // sticks to the top of the scroll container.
    <div className="sticky top-0 z-20 -mx-3 sm:-mx-6 -mt-3 sm:-mt-6 mb-4 px-1.5 h-12 flex items-center gap-1 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-700">
      <Tooltip content="Show sidebar (Ctrl+.)">
        <button
          type="button"
          aria-label="Show sidebar"
          onClick={toggle}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>
      </Tooltip>

      <div ref={menuRef} className="relative min-w-0 flex-1">
        <button
          type="button"
          onClick={() => hasMenu && setOpen((o) => !o)}
          aria-haspopup={hasMenu || undefined}
          aria-expanded={hasMenu ? open : undefined}
          className={`flex items-center gap-1 max-w-full px-1.5 py-1 rounded-md ${hasMenu ? 'hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer' : 'cursor-default'} transition-colors`}
        >
          <span className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</span>
          {hasMenu && <ChevronDown className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />}
        </button>

        {open && hasMenu && (
          <div className="absolute left-0 top-full mt-1 min-w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false)
                  a.onClick()
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  a.danger
                    ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                } cursor-pointer`}
              >
                <span className="shrink-0">{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {statusDot && <div className="shrink-0 pr-1.5">{statusDot}</div>}
    </div>
  )
}
