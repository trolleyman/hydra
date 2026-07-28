import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Settings2, ChevronDown, Check } from 'lucide-react'
import { Tooltip } from './Tooltip'

// A small per-section settings popover: a cog button that opens an anchored
// dropdown of that section's view options, closing on outside-click / Escape.
// Extracted from the old monolithic diff-toolbar cog so each section header
// (Files, Tests, Artifacts) can own just its own options - see the callers in
// DiffViewer / TestsPanel / ArtifactsPanel.
//
// The dropdown renders in a PORTAL with fixed positioning (anchored under the
// button's right edge). The section headers are sticky with their own stacking
// contexts and later-in-DOM sibling headers / file-card headers were painting
// over an in-flow dropdown; a portalled, fixed, high-z panel escapes all of
// that. Position is recomputed on scroll/resize while open.
export function SettingsPopover({
  label = 'Settings',
  width = 208,
  align = 'right',
  fitContent = false,
  icon,
  chevron = false,
  onOpen,
  children,
}: {
  label?: string
  // Glyph for the trigger button (defaults to a cog). Pair with `chevron` for a
  // menu-style trigger (e.g. the agent page's "check out locally" button).
  icon?: ReactNode
  // Show a down-chevron after the icon, signalling the button opens a menu.
  chevron?: boolean
  // Fired when the popover transitions to open (e.g. to lazily set up state the
  // panel shows). Not fired on close.
  onOpen?: () => void
  // Panel width in px. With fitContent it acts as the max width instead.
  width?: number
  // Which of the panel's edges meets the button. 'right' (default) anchors the
  // panel's right edge to the button and opens leftward - right for a cog near
  // the right of a wide section header. 'left' anchors the panel's left edge to
  // the button and opens rightward - right for a cog near the right of a narrow
  // container (the compact spawn box), where opening left would cramp it.
  align?: 'left' | 'right'
  // When true the panel sizes to its content (capped at `width`) instead of
  // always filling `width`, so it doesn't leave dead space to the right of
  // narrower controls. Not for panels with full-width children like a slider.
  fitContent?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null)

  const reposition = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Fit the panel to the room on its opening side (from the button's anchored
    // edge to the far viewport margin), shrinking below the requested width only
    // when there isn't space. A small floor keeps the option rows readable.
    let w: number
    let left: number
    if (align === 'left') {
      w = Math.min(width, Math.max(168, window.innerWidth - r.left - 8))
      left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
    } else {
      w = Math.min(width, Math.max(168, r.right - 8))
      left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
    }
    // Open below by default, but flip above when there isn't room below and
    // there is above - the compact spawn box anchors this cog near the bottom of
    // the sidebar. popRef is null on the first open (the panel isn't mounted
    // yet), so fall back to a rough height for that first placement decision.
    const estHeight = popRef.current?.offsetHeight ?? 260
    const spaceBelow = window.innerHeight - r.bottom
    if (spaceBelow < estHeight + 8 && r.top > spaceBelow) {
      setPos({ bottom: window.innerHeight - r.top + 4, left, width: w })
    } else {
      setPos({ top: r.bottom + 4, left, width: w })
    }
  }, [width, align])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const onMove = () => reposition()
    // Capture-phase scroll so we catch the inner scroll containers (the agent
    // page / inspector pane scroll, not the window).
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return
      // A nested portalled dropdown (e.g. a BranchSelector menu opened from
      // inside this popover) renders outside our DOM subtree, so a plain
      // contains() check would treat picking an option as an outside click and
      // dismiss us before the click lands. Marked menus count as inside.
      const el = t instanceof Element ? t : t.parentElement
      if (el?.closest('[data-portal-menu]')) return
      setOpen(false)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={anchorRef} className="relative inline-flex">
      <Tooltip content={label}>
        <button
          // Explicitly type="button": this cog renders inside SpawnForm's
          // <form>, where a bare <button> defaults to type="submit" - opening
          // the spawn options would submit the form and spawn the head.
          type="button"
          onClick={() => setOpen((o) => { const next = !o; if (next) onOpen?.(); return next })}
          aria-label={label}
          aria-haspopup="true"
          aria-expanded={open}
          className={`flex items-center justify-center h-7 rounded-md border transition-colors cursor-pointer ${chevron ? 'gap-0.5 px-1.5' : 'w-7'} ${open
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
            }`}
        >
          {icon ?? <Settings2 className="w-3.5 h-3.5" />}
          {chevron && <ChevronDown className="w-3 h-3 opacity-70" />}
        </button>
      </Tooltip>
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: fitContent ? 'max-content' : pos.width, maxWidth: pos.width }}
          className="z-[100] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3"
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}

// The tiny group label inside a settings popover.
export function SettingsGroupLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[10px] font-semibold text-gray-500 dark:text-gray-400 tracking-wide ${className}`}>
      {children}
    </p>
  )
}

// One choice in a SettingsSelect. `desc` is the second line of the menu row (not
// shown on the trigger); a disabled option explains itself with `desc`.
export type SettingsSelectOption = {
  id: string
  label: string
  desc?: string
  disabled?: boolean
}

// A compact dropdown for a single-choice setting inside a settings popover: a
// bordered trigger showing the current label, and a portalled menu of
// label + description rows. Use it instead of an inline list when the choices
// carry explanations that would otherwise dominate the popover (the spawn box's
// git-isolation picker), so the popover stays a short stack of one-line controls.
//
// The menu is portalled and `data-portal-menu`-marked for the same reasons as
// BranchSelector's: it must escape the spawn card's `overflow-hidden`, and the
// host SettingsPopover treats marked menus as inside itself so picking an option
// doesn't dismiss the popover.
export function SettingsSelect({
  value,
  options,
  onChange,
  label,
  width = 232,
}: {
  value: string
  options: SettingsSelectOption[]
  onChange: (id: string) => void
  // Accessible name for the trigger (the visible text is the current choice).
  label: string
  // Menu width in px; the trigger sizes to its own content.
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const reposition = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    const left = Math.min(Math.max(pad, r.left), Math.max(pad, window.innerWidth - width - pad))
    // Flip above when there isn't room below but there is above - this control
    // sits low in the spawn composer, itself pinned to the bottom of the sidebar.
    const est = menuRef.current?.offsetHeight ?? 160
    const spaceBelow = window.innerHeight - r.bottom
    if (spaceBelow < est + pad && r.top > spaceBelow) {
      setPos({ left, bottom: window.innerHeight - r.top + 4 })
    } else {
      setPos({ left, top: r.bottom + 4 })
    }
  }, [width])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const onMove = () => reposition()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const active = options.find((o) => o.id === value) ?? options[0]

  return (
    <div ref={anchorRef} className="relative flex w-fit max-w-full min-w-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors cursor-pointer w-fit max-w-full min-w-0 ${open
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
          : 'text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
      >
        <span className="truncate">{active?.label}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          data-portal-menu
          role="listbox"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width }}
          className="fixed max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-[9999] py-1"
        >
          {options.map((o) => (
            <button
              key={o.id || 'default'}
              type="button"
              role="option"
              aria-selected={o.id === value}
              disabled={o.disabled}
              onClick={() => { onChange(o.id); setOpen(false) }}
              className={`w-full flex items-start gap-2 px-2 py-1.5 text-left transition-colors ${o.disabled
                ? 'opacity-40 cursor-not-allowed'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700/60 cursor-pointer'}`}
            >
              <span className="w-3.5 shrink-0 pt-0.5">{o.id === value && <Check className="w-3.5 h-3.5 text-blue-500" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-gray-700 dark:text-gray-200">{o.label}</span>
                {o.desc && <span className="block text-[10px] text-gray-400 dark:text-gray-500 leading-snug break-words">{o.desc}</span>}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

// A radio / checkbox option row inside a settings popover.
export function SettingsOptionRow({
  type,
  name,
  checked,
  onChange,
  label,
  disabled = false,
  title,
}: {
  type: 'radio' | 'checkbox'
  name?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}) {
  return (
    // w-full on both: the wrapper replaces the label as the menu's block-level
    // child, and the label has to keep filling it so the whole row stays
    // clickable. In practice `title` is only passed to explain a DISABLED row,
    // so the tip rarely competes with the menu it sits over.
    <Tooltip content={title} className="w-full">
      <label
        className={`w-full flex items-center gap-2 py-0.5 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <input
          type={type}
          name={name}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="w-3 h-3 accent-blue-500"
        />
        <span className="text-xs text-gray-700 dark:text-gray-300">{label}</span>
      </label>
    </Tooltip>
  )
}
