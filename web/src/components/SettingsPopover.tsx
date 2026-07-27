import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Settings2 } from 'lucide-react'
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
  children,
}: {
  label?: string
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
          onClick={() => setOpen((o) => !o)}
          aria-label={label}
          aria-haspopup="true"
          aria-expanded={open}
          className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${open
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
            }`}
        >
          <Settings2 className="w-3.5 h-3.5" />
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
