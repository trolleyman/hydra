import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, FolderOpen, Plus } from 'lucide-react'
import type { ProjectInfo } from '../api'
import { formatError } from '../api/format_error'
import { folderPickerAvailable, openFolderPicker } from '../api/folderPicker'
import { useFinePointer } from '../lib/useFinePointer'
import { ProjectIcon } from '../lib/projectIcon'
import { ProjectAgentCounts } from './ProjectAgentCounts'
import { ServiceHealthWarning } from './ServiceHealthWarning'

// Project-switch shortcut hint. We bind Ctrl (not Cmd) on every platform,
// including macOS: macOS reserves Cmd+` for its own "cycle windows within an
// app", so it never reaches the page - Ctrl+` is free there and keeps one
// binding everywhere.
const SWITCH_PROJECT_HINT = 'Hold Ctrl, tap ` to switch · ⇧ for previous'

// ── Project Dropdown ───────────────────────────────────────────────────────────

export function ProjectDropdown({
  projects,
  selectedId,
  onSelect,
  onDeselect,
  onAddProject,
}: {
  projects: ProjectInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onAddProject: (path: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [showAddInput, setShowAddInput] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // Native folder picker: only offered to local clients on a system with a
  // dialog tool (the daemon checks both). `browsing` is true while the OS
  // dialog is open and we're awaiting the user's pick.
  const [pickerAvailable, setPickerAvailable] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  // triggerRef wraps the button; menuRef is the portalled menu. Both are needed
  // for outside-click detection now that the menu lives outside this subtree.
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The menu is rendered in a portal so it escapes the sidebar's
  // `overflow-hidden` (which clips its collapse width-tween and would otherwise
  // swallow the menu whenever the sidebar is narrower than the menu). We
  // position it manually from the trigger's rect.
  const [coords, setCoords] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  // The Ctrl+` switch hint is keyboard-only - hide it on touch devices.
  const finePointer = useFinePointer()

  const isOpen = open

  // Menu geometry, kept in sync with the classes on the portalled menu below.
  const MENU_WIDTH = 288 // w-72
  const GAP = 4 // mt-1

  // Position the portalled menu from the trigger's rect: below and left-aligned,
  // clamped to the viewport so it never runs off the right edge, and flipped
  // above when there isn't room below.
  useLayoutEffect(() => {
    if (!isOpen) return
    const updateCoords = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const padding = 8
      let left = rect.left
      if (left + MENU_WIDTH > window.innerWidth - padding) {
        left = Math.max(padding, window.innerWidth - MENU_WIDTH - padding)
      }
      const maxHeight = window.innerHeight * 0.7 // max-h-[70vh]
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
  }, [isOpen])

  const selected = projects.find((p) => p.id === selectedId)
  // Unread agents sitting in projects other than the one you're looking at -
  // drives the dot on the folder button ("updates waiting elsewhere").
  const otherProjectsUnread = projects
    .filter((p) => p.id !== selectedId)
    .reduce((n, p) => n + (p.unread_count ?? 0), 0)
  // Agents in other projects that are blocked on you (needs_input) - turns the
  // folder-button dot red (the stronger "needs your input" signal) instead of
  // the blue "updates waiting" dot.
  const otherProjectsNeedsInput = projects
    .filter((p) => p.id !== selectedId)
    .reduce((n, p) => n + (p.needs_input_count ?? 0), 0)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      // The menu lives in a portal, so a click inside it isn't contained by the
      // trigger - check both before treating it as an outside click.
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
      setShowAddInput(false)
      setAddError(null)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        setShowAddInput(false)
        setAddError(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useEffect(() => {
    if (showAddInput) {
      inputRef.current?.focus()
    }
  }, [showAddInput])

  useEffect(() => {
    let cancelled = false
    void folderPickerAvailable().then((a) => {
      if (!cancelled) setPickerAvailable(a)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Open the native OS folder dialog, then add the picked project immediately.
  async function handleBrowse() {
    if (browsing) return
    setBrowsing(true)
    setAddError(null)
    try {
      const res = await openFolderPicker()
      if (res.cancelled || !res.path) return
      await onAddProject(res.path)
      setShowAddInput(false)
      setOpen(false)
    } catch (err) {
      setAddError(formatError(err))
    } finally {
      setBrowsing(false)
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const path = newPath.trim()
    if (!path || adding) return
    setAdding(true)
    setAddError(null)
    try {
      await onAddProject(path)
      setNewPath('')
      setShowAddInput(false)
      setOpen(false)
    } catch (err) {
      setAddError(formatError(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div ref={triggerRef} className="relative shrink-0">
      <button
        aria-label="Select project"
        onClick={() => { setOpen((o) => !o); setShowAddInput(false); setAddError(null) }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs cursor-pointer"
      >
        <span className="relative shrink-0 inline-flex">
          <ProjectIcon icon={selected?.icon} projectId={selected?.id ?? ''} size={14} />
          {otherProjectsNeedsInput > 0 ? (
            <span
              aria-label="an agent in another project needs your input"
              className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900"
            />
          ) : otherProjectsUnread > 0 ? (
            <span
              aria-label="updates waiting in other projects"
              className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-sky-400 ring-2 ring-white dark:ring-gray-900"
            />
          ) : null}
        </span>
        <span className="truncate max-w-[160px]">{selected?.name ?? 'Select project'}</span>
        <ServiceHealthWarning projectId={selectedId} />
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && coords && createPortal(
        <div
          ref={menuRef}
          style={{ left: coords.left, top: coords.top, bottom: coords.bottom }}
          className="fixed w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-[9999] max-h-[70vh] overflow-y-auto"
        >
          {projects.length > 0 && (
            <div className="py-1 border-b border-gray-100 dark:border-gray-700">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`relative flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                    p.id === selectedId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                  onClick={() => {
                    if (p.id === selectedId) {
                      onDeselect()
                    } else {
                      onSelect(p.id)
                    }
                    setOpen(false)
                  }}
                >
                  <span className="shrink-0 mt-0.5 inline-flex text-gray-400">
                    <ProjectIcon icon={p.icon} projectId={p.id} size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.name}</div>
                    <div className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">{p.path}</div>
                  </div>
                  {/* Per-project agent tally (running/waiting/finished/
                      needs_input + an unread marker). Fixed to the trailing edge,
                      centered against the two-line name/path - nothing here
                      appears on hover, so the counts never shift. Removal moved to
                      the project's Settings page. */}
                  <ProjectAgentCounts project={p} className="shrink-0 self-center" />
                </div>
              ))}
            </div>
          )}

          <div className="py-1">
            {pickerAvailable && !showAddInput && (
              <>
                <button
                  onClick={handleBrowse}
                  disabled={browsing}
                  className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  <FolderOpen className="w-3 h-3" />
                  {browsing ? 'Waiting for folder...' : 'Browse...'}
                </button>
                {addError && (
                  <p className="text-[10px] text-red-500 px-3 pb-1 leading-snug">{addError}</p>
                )}
              </>
            )}
            {!showAddInput ? (
              <button
                onClick={() => { setShowAddInput(true); setAddError(null) }}
                className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Plus className="w-3 h-3" />
                {pickerAvailable ? 'Enter path manually...' : 'Open folder...'}
              </button>
            ) : (
              <form onSubmit={handleAdd} className="px-3 py-2">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Folder path</label>
                <input
                  ref={inputRef}
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="/absolute/path/to/project"
                  disabled={adding}
                  className="w-full text-xs font-mono px-2 py-1.5 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-500 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500 disabled:opacity-50"
                />
                {addError && (
                  <p className="text-[10px] text-red-500 mt-1 leading-snug">{addError}</p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    type="submit"
                    disabled={!newPath.trim() || adding}
                    className="flex-1 text-xs py-1 px-2 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    {adding ? 'Opening...' : 'Open'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddInput(false); setNewPath(''); setAddError(null) }}
                    className="text-xs py-1 px-2 rounded border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          {projects.length > 1 && finePointer && (
            <div className="px-3 py-1.5 border-t border-gray-100 dark:border-gray-700 text-[10px] text-gray-400 dark:text-gray-500 font-mono">
              {SWITCH_PROJECT_HINT}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
