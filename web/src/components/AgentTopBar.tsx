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
  // Lowlit keyboard-shortcut hint (e.g. "⌘M"), shown right-aligned in the menu
  // and folded into the inline button's tooltip.
  shortcut?: string
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
  inlineActions,
  rename,
}: {
  title: string
  statusDot?: ReactNode
  actions: AgentTopBarAction[]
  // Actions surfaced as buttons inline right after the title (e.g. Merge),
  // rather than tucked inside the chevron dropdown.
  inlineActions?: AgentTopBarAction[]
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
    // A real header above the scrolling content (not sticky inside it), so it
    // aligns with the sidebar header and never collides with the diff's own
    // sticky "Changes" header.
    <div className="shrink-0 h-12 px-3 sm:px-4 flex items-center gap-1 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {collapsed && (
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
      )}

      {/* Title + chevron, sized to content so the chevron sits right after the
          name; the menu right-aligns to this group. */}
      <div ref={menuRef} className="relative flex items-center gap-0.5 min-w-0">
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
            className="min-w-0 w-64 max-w-full text-sm font-semibold bg-transparent border-b border-blue-400 focus:outline-none text-gray-800 dark:text-gray-100 disabled:opacity-50"
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => rename?.onStart()}
              title={rename ? 'Rename' : title}
              className={`min-w-0 truncate text-left text-sm font-semibold text-gray-800 dark:text-gray-100 px-1 py-1 rounded transition-colors ${
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
            {inlineActions?.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={a.disabled}
                onClick={a.onClick}
                title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}
                aria-label={a.label}
                className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                  a.danger
                    ? 'border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'
                }`}
              >
                {a.icon}
              </button>
            ))}
          </>
        )}

        {open && hasMenu && (
          // Right-aligned to the chevron trigger (Claude-style); offset past any
          // inline actions (each w-7 + gap-0.5 = 1.875rem) sitting to its right.
          <div
            style={{ right: `calc(${inlineActions?.length ?? 0} * 1.875rem)` }}
            className="absolute top-full mt-1 w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1"
          >
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
                {a.shortcut && (
                  <span className="ml-auto pl-6 text-[11px] font-medium text-gray-400 dark:text-gray-500">
                    {a.shortcut}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Status dot pushed to the right, inset from the edge to match the bar's
          vertical centering. */}
      {statusDot && <div className="ml-auto pl-3">{statusDot}</div>}
    </div>
  )
}
