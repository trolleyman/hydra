import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Folder, FolderOpen, Plus, Check, X } from 'lucide-react'
import type { ProjectInfo } from '../api'
import { formatError } from '../api/format_error'
import { folderPickerAvailable, openFolderPicker } from '../api/folderPicker'
import { useDialogStore } from '../stores/dialogStore'
import { useFinePointer } from '../lib/useFinePointer'
import { ServiceHealthWarning } from './ServiceHealthWarning'

// Project-switch shortcut hint. We bind Ctrl (not Cmd) on every platform,
// including macOS: macOS reserves Cmd+` for its own "cycle windows within an
// app", so it never reaches the page — Ctrl+` is free there and keeps one
// binding everywhere.
const SWITCH_PROJECT_HINT = 'Hold Ctrl, tap ` to switch · ⇧ for previous'

// ── Project Dropdown ───────────────────────────────────────────────────────────

export function ProjectDropdown({
  projects,
  selectedId,
  onSelect,
  onDeselect,
  onAddProject,
  onRemoveProject,
  keyboardIndex,
}: {
  projects: ProjectInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onAddProject: (path: string) => Promise<void>
  onRemoveProject: (id: string) => Promise<void>
  // Drives the Ctrl+` alt-tab switcher: when non-null the dropdown is forced open
  // and the row at this index is highlighted (committed on Ctrl release by the
  // handler in RootLayout). null = normal click-driven dropdown.
  keyboardIndex: number | null
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
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLDivElement>(null)
  // The Ctrl+` switch hint is keyboard-only — hide it on touch devices.
  const finePointer = useFinePointer()

  // The Ctrl+` switcher forces the dropdown open and highlights a row; otherwise
  // it's the usual click-to-open menu.
  const keyboardActive = keyboardIndex !== null
  const isOpen = open || keyboardActive

  // Keep the keyboard-highlighted row in view as the user steps through a long
  // project list.
  useEffect(() => {
    if (keyboardActive) activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [keyboardIndex, keyboardActive])

  const selected = projects.find((p) => p.id === selectedId)
  // Unread agents sitting in projects other than the one you're looking at —
  // drives the dot on the folder button ("updates waiting elsewhere").
  const otherProjectsUnread = projects
    .filter((p) => p.id !== selectedId)
    .reduce((n, p) => n + (p.unread_count ?? 0), 0)
  // Agents in other projects that are blocked on you (needs_input) — turns the
  // folder-button dot red (the stronger "needs your input" signal) instead of
  // the blue "updates waiting" dot.
  const otherProjectsNeedsInput = projects
    .filter((p) => p.id !== selectedId)
    .reduce((n, p) => n + (p.needs_input_count ?? 0), 0)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowAddInput(false)
        setAddError(null)
      }
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

  function handleRemove(e: React.MouseEvent, projectId: string, projectName: string) {
    e.stopPropagation()
    useDialogStore.getState().show({
      title: 'Remove Project',
      message: `Remove "${projectName}" from Hydra? This will not delete any files on disk.`,
      type: 'confirm',
      showCancel: true,
      onConfirm: async () => {
        try {
          await onRemoveProject(projectId)
        } catch (err) {
          useDialogStore.getState().show({
            title: 'Remove Failed',
            message: `Failed to remove project: ${formatError(err)}`,
            type: 'error',
          })
        }
      },
    })
  }

  return (
    <div ref={dropdownRef} className="relative shrink-0">
      <button
        aria-label="Select project"
        onClick={() => { setOpen((o) => !o); setShowAddInput(false); setAddError(null) }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs cursor-pointer"
      >
        <span className="relative shrink-0">
          <Folder className="w-3.5 h-3.5" />
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

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
          {projects.length > 0 && (
            <div className="py-1 border-b border-gray-100 dark:border-gray-700">
              {projects.map((p, i) => (
                <div
                  key={p.id}
                  ref={keyboardActive && i === keyboardIndex ? activeRowRef : undefined}
                  className={`relative flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                    keyboardActive && i === keyboardIndex
                      ? 'bg-blue-100 dark:bg-blue-900/40'
                      : p.id === selectedId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                  onMouseEnter={() => setHoveredId(p.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    if (p.id === selectedId) {
                      onDeselect()
                    } else {
                      onSelect(p.id)
                    }
                    setOpen(false)
                  }}
                >
                  <Folder className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.name}</div>
                    <div className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">{p.path}</div>
                  </div>
                  {(p.needs_input_count ?? 0) > 0 ? (
                    <span
                      aria-label={`${p.needs_input_count} agents need your input`}
                      className="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-red-500"
                    />
                  ) : (p.unread_count ?? 0) > 0 ? (
                    <span
                      aria-label={`${p.unread_count} agents with unread changes`}
                      className="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-sky-500"
                    />
                  ) : null}
                  {p.id === selectedId && hoveredId !== p.id && (
                    <Check className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  )}
                  {hoveredId === p.id && (
                    <button
                      onClick={(e) => handleRemove(e, p.id, p.name)}
                      className="shrink-0 mt-0.5 p-0.5 rounded text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
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
                  {browsing ? 'Waiting for folder…' : 'Browse…'}
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
                {pickerAvailable ? 'Enter path manually…' : 'Open folder…'}
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
                    {adding ? 'Opening…' : 'Open'}
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
        </div>
      )}
    </div>
  )
}
