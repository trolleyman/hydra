import { useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { PanelLeftOpen, MoreHorizontal } from 'lucide-react'
import { useSidebarStore } from '../lib/sidebar'
import { useFinePointer } from '../lib/useFinePointer'

export interface AgentTopBarAction {
  label: string
  icon: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  // Lowlit keyboard-shortcut hint (e.g. "Ctrl+M"), shown right-aligned in the
  // overflow menu and folded into a button's tooltip — only on devices with a
  // physical keyboard (see useFinePointer).
  shortcut?: string
}

// Inline-rename wiring for the title. When provided, clicking the title text (or
// the menu's Rename item / F2) edits it in place; the I-beam cursor signals it's
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

// gap-1 between toolbar buttons, in px — used by the fit calculation below.
const GAP = 4
function actionBtnClass(mode: 'labels' | 'icons', danger?: boolean): string {
  const base =
    'shrink-0 h-7 inline-flex items-center justify-center rounded-md border text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer'
  const shape = mode === 'labels' ? 'gap-1.5 px-2' : 'w-7'
  const color = danger
    ? 'border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
    : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'
  return `${base} ${shape} ${color}`
}

const moreBtnClass =
  'shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors cursor-pointer'

function actionTitle(a: AgentTopBarAction, showShortcut: boolean): string {
  return showShortcut && a.shortcut ? `${a.label} (${a.shortcut})` : a.label
}

// An action toolbar that adapts to the space the header gives it: show every
// action as an icon+label button when it all fits, fall back to icon-only when
// it doesn't, and once even the icons won't fit, fold the lowest-priority ones
// (from the right) into an overflow "⋯" menu that sits after the buttons. The
// title has priority over the buttons: we reserve its full (untruncated) width
// first, so the buttons collapse into the menu before the title ever truncates —
// only a title long enough to fill the bar (leaving just room for the "⋯" button)
// starts to truncate. All widths are measured off-screen, so the fit is exact
// rather than breakpoint-guessed and never leaves a half-clipped button.
function AdaptiveActions({
  actions,
  title,
  showShortcut,
}: {
  actions: AgentTopBarAction[]
  title: string
  showShortcut: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const labeledRefs = useRef<(HTMLButtonElement | null)[]>([])
  const iconRefs = useRef<(HTMLButtonElement | null)[]>([])
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const titleMeasureRef = useRef<HTMLButtonElement | null>(null)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const [vis, setVis] = useState<{ mode: 'labels' | 'icons'; count: number }>({ mode: 'icons', count: actions.length })
  const [menuOpen, setMenuOpen] = useState(false)

  const recompute = useCallback(() => {
    // Measure against the parent row (title + toolbar). Read via parentElement
    // rather than an ancestor-supplied ref: ancestor refs attach after this
    // child's layout effect, so a passed ref would still be null on first measure.
    const cont = rootRef.current?.parentElement
    if (!cont) return
    const n = actions.length
    const labeled = labeledRefs.current.slice(0, n).map((b) => b?.offsetWidth ?? 0)
    const icons = iconRefs.current.slice(0, n).map((b) => b?.offsetWidth ?? 0)
    const more = moreRef.current?.offsetWidth ?? 28
    // +1 guards against sub-pixel rounding triggering an unwanted ellipsis.
    const titleNatural = (titleMeasureRef.current?.offsetWidth ?? 0) + 1
    // Bail until the off-screen measurer has laid out (avoids a 0-width pass).
    if (labeled.length < n || labeled.some((w) => w === 0)) return
    // Reserve the title's full width first — but never more than leaves room for
    // the "⋯" button, so a pathologically long title still yields the menu.
    const titleReserve = Math.min(titleNatural, Math.max(0, cont.clientWidth - more - GAP))
    const budget = Math.max(0, cont.clientWidth - titleReserve - GAP)
    const span = (arr: number[], k: number) => arr.slice(0, k).reduce((a, b) => a + b, 0) + Math.max(0, k - 1) * GAP
    let next: { mode: 'labels' | 'icons'; count: number }
    if (span(labeled, n) <= budget) {
      next = { mode: 'labels', count: n }
    } else if (span(icons, n) <= budget) {
      next = { mode: 'icons', count: n }
    } else {
      // Icon-only with overflow: greedily keep the highest-priority icons that
      // fit alongside the reserved "⋯" button; the rest fold into the menu.
      let used = 0
      let k = 0
      for (let i = 0; i < n; i++) {
        const add = icons[i] + (i > 0 ? GAP : 0)
        if (used + add + GAP + more <= budget) {
          used += add
          k = i + 1
        } else break
      }
      next = { mode: 'icons', count: k }
    }
    setVis((prev) => (prev.mode === next.mode && prev.count === next.count ? prev : next))
  }, [actions.length, title])

  // Measure + recompute before paint, and on every container resize.
  useLayoutEffect(() => {
    recompute()
    const cont = rootRef.current?.parentElement
    if (!cont || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => recompute())
    ro.observe(cont)
    return () => ro.disconnect()
  }, [recompute])

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menuOpen])

  const count = Math.min(vis.count, actions.length)
  const visible = actions.slice(0, count)
  const hidden = actions.slice(count)
  const overflow = hidden.length > 0

  return (
    <div ref={rootRef} className="shrink-0 flex items-center gap-1">
      {visible.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={a.disabled}
          onClick={a.onClick}
          aria-label={a.label}
          title={actionTitle(a, showShortcut)}
          className={actionBtnClass(vis.mode, a.danger)}
        >
          {a.icon}
          {vis.mode === 'labels' && <span className="whitespace-nowrap">{a.label}</span>}
        </button>
      ))}

      {overflow && (
        <div ref={menuWrapRef} className="relative">
          <button
            type="button"
            aria-label="More actions"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className={moreBtnClass}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
              {hidden.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  disabled={a.disabled}
                  onClick={() => {
                    setMenuOpen(false)
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
                  {showShortcut && a.shortcut && (
                    <span className="ml-auto pl-6 text-[11px] font-medium text-gray-400 dark:text-gray-500">{a.shortcut}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Off-screen measurer: a labeled and an icon-only copy of every button (plus
          the "⋯" button) so recompute() can read their natural widths. invisible +
          absolute keeps it out of flow and unpainted; whitespace-nowrap stops the
          labels wrapping so the measured widths are the real single-line widths. */}
      <div aria-hidden className="invisible pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1">
        {actions.map((a, i) => (
          <button key={`l-${a.label}`} ref={(el) => { labeledRefs.current[i] = el }} className={actionBtnClass('labels', a.danger)} tabIndex={-1}>
            {a.icon}
            <span className="whitespace-nowrap">{a.label}</span>
          </button>
        ))}
        {actions.map((a, i) => (
          <button key={`i-${a.label}`} ref={(el) => { iconRefs.current[i] = el }} className={actionBtnClass('icons', a.danger)} tabIndex={-1}>
            {a.icon}
          </button>
        ))}
        <button ref={moreRef} className={moreBtnClass} tabIndex={-1}>
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {/* Natural (untruncated) title width — mirrors the real title button's font
            + padding but sizes to content, so recompute() can reserve its space. */}
        <button ref={titleMeasureRef} className="text-sm font-semibold px-1 py-1 whitespace-nowrap" tabIndex={-1}>
          {title}
        </button>
      </div>
    </div>
  )
}

// The agent page's header bar: the agent name (click / F2 to rename) with an
// adaptive row of action buttons on the right and a status dot. The actions
// collapse responsively (labels → icons → overflow menu) so they never spill out
// of the bar. While the sidebar is collapsed the bar also hosts the show-sidebar
// toggle.
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
  // Only surface keyboard hints on devices that actually have a keyboard.
  const showShortcut = useFinePointer()

  const editing = rename?.editing ?? false

  return (
    // A real header above the scrolling content (not sticky inside it), so it
    // aligns with the sidebar header and never collides with the diff's own
    // sticky "Changes" header.
    <div className="shrink-0 h-12 px-3 sm:px-4 flex items-center gap-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {collapsed && (
        <button
          type="button"
          aria-label="Show sidebar"
          title="Show sidebar (Ctrl+.)"
          onClick={toggle}
          className="shrink-0 -ml-1 w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>
      )}

      {/* Title + adaptive actions share this row; the title flexes/truncates so
          the toolbar always has room to lay out. AdaptiveActions measures this
          row via its own parentElement, so the row needs no ref. */}
      <div className="flex items-center gap-1 min-w-0 flex-1">
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
          <button
            type="button"
            onClick={() => rename?.onStart()}
            title={rename ? 'Rename' : title}
            className={`min-w-0 flex-1 truncate text-left text-sm font-semibold text-gray-800 dark:text-gray-100 px-1 py-1 rounded transition-colors ${
              rename ? 'cursor-text hover:bg-gray-100 dark:hover:bg-gray-700' : 'cursor-default'
            }`}
          >
            {title}
          </button>
        )}

        {!editing && actions.length > 0 && (
          <AdaptiveActions actions={actions} title={title} showShortcut={showShortcut} />
        )}
      </div>

      {/* Status dot pinned to the right, inset to match the bar's centering. */}
      {statusDot && <div className="shrink-0">{statusDot}</div>}
    </div>
  )
}
