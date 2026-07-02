import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { HighlightedTextarea } from './HighlightedTextarea'
import type { RepositoryUncommittedChanges } from '../api'

// ── Uncommitted-changes warning chip ───────────────────────────────────────────
// Sits next to the sidebar's Repository button when the project root's working
// tree is dirty — most often because saving Settings rewrote .hydra/config.toml.
// Clicking it opens a popover listing the dirty paths with a prefilled commit
// message and a "Commit" that commits exactly the listed paths.

// Default commit message: name the file when there's exactly one (the common
// config-save case), otherwise just say how many paths are being swept up.
function suggestedMessage(uncommitted: RepositoryUncommittedChanges): string {
  if (uncommitted.files.length === 1) {
    return `Update ${uncommitted.files[0].path}`
  }
  return `Commit ${uncommitted.files.length} local changes`
}

export function UncommittedChip({
  uncommitted,
  committing,
  onCommit,
}: {
  uncommitted: RepositoryUncommittedChanges
  committing: boolean
  // Commits the given paths with the given message; resolves true on success so
  // the popover knows to close (failures toast and leave it open for a retry).
  onCommit: (message: string, paths: string[]) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [coords, setCoords] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  // Popover geometry, kept in sync with the classes on the portalled box below.
  const MENU_WIDTH = 288 // w-72
  const GAP = 4

  // Position the portalled popover from the trigger's rect: below and
  // left-aligned, clamped to the viewport, flipped above when there's no room.
  useLayoutEffect(() => {
    if (!open) return
    const updateCoords = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const padding = 8
      let left = rect.left
      if (left + MENU_WIDTH > window.innerWidth - padding) {
        left = Math.max(padding, window.innerWidth - MENU_WIDTH - padding)
      }
      const maxHeight = window.innerHeight * 0.6
      const spaceBelow = window.innerHeight - rect.bottom
      if (spaceBelow < maxHeight && rect.top > spaceBelow) {
        setCoords({ left, bottom: window.innerHeight - rect.top + GAP })
      } else {
        setCoords({ left, top: rect.bottom + GAP })
      }
    }
    updateCoords()
    window.addEventListener('scroll', updateCoords, true)
    window.addEventListener('resize', updateCoords)
    return () => {
      window.removeEventListener('scroll', updateCoords, true)
      window.removeEventListener('resize', updateCoords)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      // The popover lives in a portal, so a click inside it isn't contained by
      // the trigger — check both before treating it as an outside click.
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (uncommitted.total === 0) return null

  const submit = async () => {
    const msg = message.trim()
    if (!msg || committing) return
    // Commit exactly what the popover shows — with more paths dirty than the
    // list cap, the rest stay uncommitted (the chip persists with the
    // remainder, so another round sweeps them).
    if (await onCommit(msg, uncommitted.files.map((f) => f.path))) setOpen(false)
  }

  const label = `${uncommitted.total} uncommitted change${uncommitted.total === 1 ? '' : 's'}`
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="uncommitted-chip"
        aria-label={label}
        title={open ? undefined : `${label} in the project checkout — click to review and commit`}
        onClick={() => {
          setMessage(suggestedMessage(uncommitted))
          setOpen((o) => !o)
        }}
        className="shrink-0 flex items-center gap-0.5 px-1 py-1 rounded-md text-xs font-medium tabular-nums text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors cursor-pointer"
      >
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        {uncommitted.total}
      </button>

      {open && coords && createPortal(
        <div
          ref={menuRef}
          style={{ left: coords.left, top: coords.top, bottom: coords.bottom }}
          className="fixed w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-[9999] p-3 space-y-2"
        >
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
            Uncommitted changes in the project checkout
          </p>
          <ul className="max-h-48 overflow-y-auto space-y-0.5">
            {uncommitted.files.map((f) => (
              <li key={f.path} className="flex items-baseline gap-1.5 text-xs">
                <span className="shrink-0 w-14 text-gray-400 dark:text-gray-500">{f.status}</span>
                <span className="truncate font-mono text-gray-700 dark:text-gray-300" title={f.path}>
                  {f.path}
                </span>
              </li>
            ))}
            {uncommitted.total > uncommitted.files.length && (
              <li className="text-xs text-gray-400 dark:text-gray-500">
                …and {uncommitted.total - uncommitted.files.length} more, not included in this commit
              </li>
            )}
          </ul>
          <HighlightedTextarea
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Enter inserts a newline (multi-line commit messages);
              // Ctrl/Cmd+Enter commits, mirroring the spawn box.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="Commit message"
            // Both HighlightedTextarea layers are absolutely positioned, so the
            // wrapper must supply the height (~2 lines + padding).
            wrapperClassName="w-full h-14 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500"
            textClassName="px-2 py-1.5 text-xs leading-relaxed placeholder-gray-400 dark:placeholder-gray-500"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="text-[10px] text-gray-400 dark:text-gray-500 select-none">Ctrl+Enter to commit</span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={committing || message.trim() === ''}
              className={
                committing || message.trim() === ''
                  ? 'shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                  : 'shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer'
              }
            >
              {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Commit'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
