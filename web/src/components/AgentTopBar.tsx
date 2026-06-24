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

// Inline-rename wiring for the title. When provided, clicking the title text (or
// the menu's Rename item) edits it in place; the I-beam cursor signals it's
// editable. Omitted for read-only (archived) agents.
export interface AgentTopBarRename {
  editing: boolean
  draft: string
  saving: boolean
  onStart: () => void
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}

// The agent page's header bar (Claude-style): the agent name with an actions
// dropdown on the left and a status dot on the right. It is the single home for
// the title now — there is no separate H1 below it. While the sidebar is
// collapsed it also hosts the show-sidebar toggle (there's no other chrome to
// hold it); when the sidebar is open the title simply starts at the left.
export function AgentTopBar({
  title,
  statusDot,
  actions,
  rename,
}: {
  title: string
  statusDot?: ReactNode
  actions: AgentTopBarAction[]
  rename?: AgentTopBarRename
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

  const hasMenu = actions.length > 0
  const editing = rename?.editing ?? false

  return (
    // Bleed past the page padding (p-3 / sm:p-6) so the bar spans edge-to-edge and
    // sticks to the top of the scroll container.
    <div className="sticky top-0 z-20 -mx-3 sm:-mx-6 -mt-3 sm:-mt-6 mb-4 px-1.5 h-12 flex items-center gap-1 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-700">
      {collapsed && (
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
      )}

      <div ref={menuRef} className="relative flex-1 min-w-0 flex items-center gap-0.5">
        {editing && rename ? (
          <input
            autoFocus
            value={rename.draft}
            disabled={rename.saving}
            onChange={(e) => rename.onChange(e.target.value)}
            onBlur={rename.onSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                rename.onSave()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                rename.onCancel()
              }
            }}
            className="flex-1 min-w-0 text-sm font-semibold bg-transparent border-b border-blue-400 focus:outline-none text-gray-800 dark:text-gray-100 disabled:opacity-50"
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => rename?.onStart()}
              title={rename ? 'Rename' : title}
              className={`flex-1 min-w-0 truncate text-left text-sm font-semibold text-gray-800 dark:text-gray-100 px-1 py-1 rounded transition-colors ${
                rename ? 'cursor-text hover:bg-gray-100 dark:hover:bg-gray-700' : 'cursor-default'
              }`}
            >
              {title}
            </button>
            {hasMenu && (
              <button
                type="button"
                aria-label="Agent actions"
                aria-haspopup="true"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            )}
          </>
        )}

        {open && hasMenu && (
          // Right-aligned to the dropdown trigger (Claude-style).
          <div className="absolute right-0 top-full mt-1 min-w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false)
                  a.onClick()
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                  a.danger
                    ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <span className="shrink-0">{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {statusDot && <div className="shrink-0 pl-1">{statusDot}</div>}
    </div>
  )
}
