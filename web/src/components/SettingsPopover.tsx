import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Settings2, ChevronDown, Check, RotateCcw } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { placeMenu, type MenuAlign } from '../lib/anchorMenu'

// A small per-section settings popover: a cog button that opens an anchored
// dropdown of that section's view options, closing on outside-click / Escape.
// Extracted from the old monolithic diff-toolbar cog so each section header
// (Files, Tests, Artifacts) can own just its own options - see the callers in
// DiffViewer / TestsPanel / ArtifactsPanel.
//
// The dropdown renders in a PORTAL with fixed positioning (anchored under the
// button). The section headers are sticky with their own stacking contexts and
// later-in-DOM sibling headers / file-card headers were painting over an
// in-flow dropdown; a portalled, fixed, high-z panel escapes all of that.
// Position is recomputed on scroll/resize while open.
export function SettingsPopover({
  label = 'Settings',
  width = 208,
  align = 'auto',
  fitContent = false,
  icon,
  chevron = false,
  active = false,
  tooltip,
  onReset,
  resetLabel = 'Reset to defaults',
  onOpen,
  children,
}: {
  label?: string
  // Glyph for the trigger button (defaults to a cog). Pair with `chevron` for a
  // menu-style trigger (e.g. the agent page's "check out locally" button).
  icon?: ReactNode
  // Show a down-chevron after the icon, signalling the button opens a menu.
  chevron?: boolean
  // The panel holds at least one non-default choice. The trigger then keeps the
  // "on" look (and a dot) while CLOSED, so a setting made in here can't be
  // forgotten just because the panel that holds it is shut.
  active?: boolean
  // Tooltip for the trigger, when it should say more than `label` - typically
  // what is non-default while `active`. `label` stays the accessible name.
  tooltip?: ReactNode
  // When given, a small reset button sits in the panel's top-right corner.
  // Render it only when there IS something to reset (it pairs with `active`),
  // so the panel carries no dead control in the common case.
  onReset?: () => void
  resetLabel?: string
  // Fired when the popover transitions to open (e.g. to lazily set up state the
  // panel shows). Not fired on close.
  onOpen?: () => void
  // Panel width in px. With fitContent it acts as the max width instead.
  width?: number
  // Which of the panel's edges meets the button - see placeMenu. 'auto'
  // (default) opens rightward when the panel fits there and falls back to
  // leftward when it doesn't, which covers both a cog at the right end of a
  // wide section header and a trigger sitting mid-row. Pin it only to override
  // that judgement.
  align?: MenuAlign
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
    // Fit the panel to the room on its opening side, shrinking below the
    // requested width only when there isn't space. A small floor keeps the
    // option rows readable.
    const { left, width: w } = placeMenu({
      triggerLeft: r.left,
      triggerRight: r.right,
      width,
      viewportWidth: window.innerWidth,
      align,
      minWidth: 168,
    })
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

  // Re-place as soon as the panel exists: the first pass has to guess its height
  // (the portal isn't mounted until `pos` is set), and a panel taller than that
  // guess would otherwise stay pinned below the button and run off the bottom of
  // the viewport until something scrolled.
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    popRef.current = node
    if (node) reposition()
  }, [reposition])

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
      <Tooltip content={tooltip ?? label}>
        <button
          // Explicitly type="button": this cog renders inside SpawnForm's
          // <form>, where a bare <button> defaults to type="submit" - opening
          // the spawn options would submit the form and spawn the head.
          type="button"
          onClick={() => setOpen((o) => { const next = !o; if (next) onOpen?.(); return next })}
          aria-label={label}
          aria-haspopup="true"
          aria-expanded={open}
          className={`relative flex items-center justify-center h-7 rounded-md border transition-colors cursor-pointer ${chevron ? 'gap-0.5 px-1.5' : 'w-7'} ${open
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : active
              ? 'text-blue-600 dark:text-blue-300 bg-white dark:bg-gray-700 border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30'
              : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
            }`}
        >
          {icon ?? <Settings2 className="w-3.5 h-3.5" />}
          {chevron && <ChevronDown className="w-3 h-3 opacity-70" />}
          {/* The dot carries the state on its own, so it reads at a glance and
              survives the trigger's blue tint being lost to a hover/open style.
              Ringed in the card's own background so it reads as a badge sitting
              on the button's corner rather than a smudge on its border. */}
          {active && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500 ring-2 ring-white dark:ring-gray-800" />
          )}
        </button>
      </Tooltip>
      {open && pos && createPortal(
        <div
          ref={measureRef}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: fitContent ? 'max-content' : pos.width, maxWidth: pos.width }}
          className="relative z-[100] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 animate-popover-in"
        >
          {/* Absolute, so it costs the stacked controls no vertical room: the
              panel's first row is a short group label, which it sits beside. */}
          {onReset && (
            // The absolute positioning goes on the Tooltip's wrapper, not the
            // button: an in-flow (if empty) inline wrapper at the top of the
            // panel would open a line box's worth of blank space above the
            // first group label.
            <Tooltip content={resetLabel} className="absolute top-1.5 right-1.5">
              <button
                type="button"
                onClick={onReset}
                aria-label={resetLabel}
                className="flex items-center justify-center w-6 h-6 rounded-md text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}
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
    <p className={`text-3xs font-semibold text-gray-500 dark:text-gray-400 tracking-wide ${className}`}>
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
    const { left } = placeMenu({ triggerLeft: r.left, triggerRight: r.right, width, viewportWidth: window.innerWidth, pad })
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
          className="fixed max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-[9999] py-1 animate-popover-in"
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
                {o.desc && <span className="block text-3xs text-gray-400 dark:text-gray-500 leading-snug break-words">{o.desc}</span>}
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
