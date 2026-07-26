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
  children,
}: {
  label?: string
  // Dropdown width in px.
  width?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  const reposition = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Anchor the dropdown's right edge to the button's right edge, just below it,
    // clamped a few px off the viewport edges.
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
  }, [])

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
          style={{ position: 'fixed', top: pos.top, right: pos.right, width }}
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
    <label
      title={title}
      className={`flex items-center gap-2 py-0.5 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
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
  )
}
