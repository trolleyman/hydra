import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronUp, Eye, EyeOff, FolderOpen, GripVertical, Pencil, Plus, X } from 'lucide-react'
import type { ProjectInfo, ResolvedPathResponse } from '../api'
import { formatError } from '../api/format_error'
import { folderPickerAvailable, openFolderPicker } from '../api/folderPicker'
import { useFinePointer } from '../lib/useFinePointer'
import { placeMenu } from '../lib/anchorMenu'
import { ProjectIcon } from '../lib/projectIcon'
import { api } from '../stores/apiClient'
import { useDialogStore } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import { expandOrder, reorderProjects, setProjectHidden, useProjectStore, visibleProjects } from '../stores/projectStore'
import { ProjectAgentCounts, ProjectAttentionDot } from './ProjectAgentCounts'
import { ServiceHealthWarning } from './ServiceHealthWarning'
import { pillText } from '../lib/branchPills'

// Project-switch shortcut hint. We bind Ctrl (not Cmd) on every platform,
// including macOS: macOS reserves Cmd+` for its own "cycle windows within an
// app", so it never reaches the page - Ctrl+` is free there and keeps one
// binding everywhere.
const SWITCH_PROJECT_HINT = 'Hold Ctrl, tap ` to switch · ⇧ for previous'

// Built-ins (the scratch project) first, everything else in the order the server
// stores - which is the user's own drag-to-reorder order (see reorderProjects).
// Only the dropdown pins built-ins: the Ctrl+` switcher is deliberately left on
// pure recency, because pinning anything to the front of an alt-tab list breaks
// the "one tap = previous project" model it exists for.
function orderProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))
}

// What the resolved path preview says about the folder underneath, or null when
// it is exactly what you want (an existing git repo). Only the server can tell
// us any of this, hence the resolve call - the browser knows neither the
// server's home directory nor its filesystem.
function pathHint(r: ResolvedPathResponse): string | null {
  if (!r.exists) return 'Does not exist yet - you will be asked to create it.'
  if (!r.is_dir) return 'Not a folder.'
  if (!r.is_git_repo) return 'Not a git repository - you will be asked to initialize one.'
  if (r.repo_root && r.repo_root !== r.path) return `A subfolder of the git repository ${r.repo_root}.`
  return null
}

// moveProject returns the project IDs with `id` lifted out and re-inserted at
// `insertAt`, an insertion index measured against the list *before* the removal
// (which is what a drop position gives us).
function moveProject(ordered: ProjectInfo[], id: string, insertAt: number): string[] {
  const ids = ordered.map((p) => p.id)
  const from = ids.indexOf(id)
  if (from < 0) return ids
  ids.splice(from, 1)
  ids.splice(insertAt > from ? insertAt - 1 : insertAt, 0, id)
  return ids
}

// What a row needs to take part in reordering. Undefined for a pinned built-in,
// and for every row when there is nothing to reorder (fewer than two of the
// user's own projects).
interface RowReorder {
  // True while this row is the one being dragged - it dims so the drop
  // indicator, not the row under the pointer, reads as "where this lands".
  dragging: boolean
  // Fine pointer = drag the row. Coarse (touch) = up/down buttons, because
  // HTML5 drag-and-drop never fires from a touchscreen.
  finePointer: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (delta: -1 | 1) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
}

// The reorder control sits *in the project icon's place* rather than in a gutter
// of its own: a handle column would push every row's icon across, including the
// rows that can't be reordered, which is a permanent cost for an occasional job.
// Only edit mode shows it - the plain list stays a plain list - though a mouse
// can still drag a row without entering the mode.
function ReorderControl({ project: p, reorder }: { project: ProjectInfo; reorder: RowReorder }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation() // never switch project
  if (!reorder.finePointer) {
    // Touch: HTML5 drag never fires, so edit mode swaps the icon for a compact
    // up/down pair. This is the only reorder affordance a touch user gets.
    return (
      <span className="flex flex-col -my-1 -ml-0.5 text-gray-400 dark:text-gray-500">
        <button
          type="button"
          aria-label={`Move ${p.name} up`}
          disabled={!reorder.canMoveUp}
          onClick={(e) => { stop(e); reorder.onMove(-1) }}
          className="p-1 rounded cursor-pointer disabled:opacity-25 disabled:cursor-default hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          type="button"
          aria-label={`Move ${p.name} down`}
          disabled={!reorder.canMoveDown}
          onClick={(e) => { stop(e); reorder.onMove(1) }}
          className="p-1 rounded cursor-pointer disabled:opacity-25 disabled:cursor-default hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      // Native title, not <Tooltip>: this is a drag handle, and a tooltip opened
      // on the pre-drag hover would hang stranded once the drag starts (see the
      // tooltip conventions in CLAUDE.md). The browser suppresses a native one.
      title="Drag to reorder (or press the up/down arrows)"
      aria-label={`Reorder ${p.name}`}
      onClick={stop}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
        e.preventDefault() // don't scroll the menu
        e.stopPropagation()
        reorder.onMove(e.key === 'ArrowUp' ? -1 : 1)
      }}
      className="absolute inset-0 flex items-center justify-center text-gray-400 dark:text-gray-500 cursor-grab active:cursor-grabbing focus:outline-none focus-visible:text-blue-500"
    >
      <GripVertical className="w-3.5 h-3.5" />
    </button>
  )
}

// One row of the project menu. Built-ins render without the path line - a
// built-in's path (~/.local/share/hydra/scratch) is noise, not information.
function ProjectRow({
  project: p,
  selected,
  editing,
  onClick,
  reorder,
  onToggleHidden,
  onRemove,
}: {
  project: ProjectInfo
  selected: boolean
  // Edit mode: reorder handles are pinned instead of hover-only, hiding and
  // removal are offered, and the row no longer switches project when clicked.
  editing: boolean
  onClick: () => void
  reorder?: RowReorder
  onToggleHidden?: () => void
  onRemove?: () => void
}) {
  // Handles belong to edit mode: outside it the row still drags (a mouse can
  // always just pick a project up), but the list stays a plain list.
  const swapIcon = reorder != null && editing
  // A hidden project is only listed here (edit mode) and, still un-dimmed, on
  // the picker of the project you are actually in - so the fade means "this one
  // is not in the list", not "this one is disabled".
  const dim = editing && p.hidden ? 'opacity-45' : ''
  return (
    <div
      // mx-1 + rounded: the highlight/hover is an inset pill, so the selected
      // row doesn't butt against the menu's py-1 padding (which read as a stray
      // white strip above/below edge rows).
      className={`group relative flex items-start gap-2.5 mx-1 px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
        editing ? 'cursor-default' : 'cursor-pointer'
      } ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${reorder?.dragging ? 'opacity-40' : ''}`}
      onClick={onClick}
      draggable={reorder != null && reorder.finePointer}
      onDragStart={reorder?.onDragStart}
      onDragEnd={reorder?.onDragEnd}
    >
      {/* Icon slot, fixed at the icon's own size so swapping the grip in and out
          of it never moves anything. */}
      <span className={`relative shrink-0 mt-0.5 inline-flex items-center justify-center w-3.5 h-3.5 text-gray-400 ${dim}`}>
        <ProjectIcon
          icon={p.icon}
          projectId={p.id}
          size={14}
          className={swapIcon ? 'opacity-0' : ''}
        />
        {swapIcon && <ReorderControl project={p} reorder={reorder} />}
      </span>
      <div className={`min-w-0 flex-1 ${dim}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.name}</span>
          {/* Needs-input/unread notification dot, right of the name so "this
              project wants you" reads before the tally. */}
          <ProjectAttentionDot project={p} />
        </div>
        {/* Built-ins have no meaningful path to show, and an explanatory
            subtitle would be noise in a list you scan often - so the second
            line is simply omitted rather than replaced. */}
        {!p.builtin && (
          <div className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">{p.path}</div>
        )}
      </div>
      {/* Per-project agent tally (running/waiting/finished/needs_input). Fixed
          to the trailing edge, centered against the two-line name/path - nothing
          appears on plain hover, so the counts never shift; edit mode trades
          them for the hide and remove buttons. */}
      {editing && (onToggleHidden || onRemove) ? (
        <span className="shrink-0 self-center flex items-center gap-0.5">
          {onToggleHidden && (
            <button
              type="button"
              // Hidden rows only exist in this mode, so the label says what the
              // click does *and* what the row's state is - the crossed-out eye
              // alone reads as "hidden" to some people and "hide me" to others.
              aria-label={p.hidden ? `Show ${p.name} in the project list` : `Hide ${p.name} from the project list`}
              aria-pressed={!!p.hidden}
              onClick={(e) => { e.stopPropagation(); onToggleHidden() }}
              className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
            >
              {p.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${p.name} from Hydra`}
              onClick={(e) => { e.stopPropagation(); onRemove() }}
              className="p-1 rounded text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      ) : (
        <ProjectAgentCounts project={p} className="shrink-0 self-center" />
      )}
    </div>
  )
}

// ── Project Dropdown ───────────────────────────────────────────────────────────

// memo: lives in the RootLayout sidebar header, which re-renders on every
// project/agent refresh; the props are stable across those (the project store
// preserves list identity on no-op refetches), so the dropdown skips them.
export const ProjectDropdown = memo(function ProjectDropdown({
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
  // Live preview of where the typed path lands, resolved by the server (see
  // pathHint). Kept with the input it answers so a result for an older keystroke
  // is simply ignored rather than flashed against the current text.
  const [resolved, setResolved] = useState<{ input: string; result: ResolvedPathResponse } | null>(null)
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
  // The Ctrl+` switch hint is keyboard-only - hide it on touch devices. It also
  // decides the reorder affordance: drag on a mouse, up/down buttons on touch.
  const finePointer = useFinePointer()
  // Drag-to-reorder: the project being dragged, and the index it would be
  // inserted at (measured against the rendered list, so `ordered.length` means
  // "after the last row").
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  // Edit mode: pins the reorder handles (the only way to reorder on a touch
  // screen) and turns the per-row agent tally into a remove button. Kept a mode
  // rather than always-on hover affordances, because "remove" on hover is what
  // this menu used to have and it was too easy to hit by accident.
  const [editing, setEditing] = useState(false)
  // A drag can't outlive the menu (closing it unmounts every drop target), so
  // every path that closes the menu drops it - otherwise the next open would
  // render a row still dimmed as "being dragged". Edit mode is dropped with it:
  // reopening the menu should be the plain list again.
  const clearDrag = () => { setDragId(null); setDropIndex(null); setEditing(false) }

  const isOpen = open

  // Menu geometry, kept in sync with the classes on the portalled menu below.
  const MENU_WIDTH = 288 // w-72
  const GAP = 4 // mt-1

  // Position the portalled menu from the trigger's rect: below and opening
  // rightward (flipping to open leftward if it would run off the right edge -
  // see placeMenu), and flipped above when there isn't room below.
  useLayoutEffect(() => {
    if (!isOpen) return
    const updateCoords = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const { left } = placeMenu({
        triggerLeft: rect.left,
        triggerRight: rect.right,
        width: MENU_WIDTH,
        viewportWidth: window.innerWidth,
      })
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
      clearDrag()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        setShowAddInput(false)
        setAddError(null)
        clearDrag()
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

  // Resolve the typed path as the user types, debounced. This is what turns
  // "~/code/hydra" (or a bare "code/hydra", which resolves against home) into
  // the absolute path shown under the input - and confirmed in the trust prompt.
  useEffect(() => {
    const typed = newPath.trim()
    if (!typed) return
    let cancelled = false
    const t = setTimeout(() => {
      api.default.resolvePath(typed)
        .then((result) => { if (!cancelled) setResolved({ input: typed, result }) })
        .catch(() => { if (!cancelled) setResolved(null) })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [newPath])

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
      setResolved(null)
      setShowAddInput(false)
      setOpen(false)
    } catch (err) {
      setAddError(formatError(err))
    } finally {
      setAdding(false)
    }
  }

  // The rendered list, plus the span of it the user may reorder: built-ins are
  // pinned to the top, so everything from the first non-built-in down is fair
  // game and nothing can be dropped above that line.
  //
  // Hidden projects are listed only in edit mode - which is the one place they
  // can be brought back, so the mode has to show everything - and, so the picker
  // never reads as "nothing selected", whichever one you currently have open.
  const allOrdered = orderProjects(projects)
  const ordered = editing ? allOrdered : visibleProjects(allOrdered, selectedId)
  const firstMovable = ordered.findIndex((p) => !p.builtin)
  const canReorder = firstMovable >= 0 && ordered.length - firstMovable > 1
  // Edit mode is worth offering as soon as there is one project to remove, even
  // if there is nothing to reorder yet. Measured against the *full* list: edit
  // mode is the only way to bring a hidden project back, so hiding everything
  // must not take away the door.
  const canEditList = allOrdered.some((p) => !p.builtin || p.hidden)

  // Persist a new order. No-op when the drag put everything back where it was.
  // The dragged rows are only the ones on screen, so the hidden projects are
  // folded back in (expandOrder) before the list is sent - otherwise the server,
  // which appends anything the client didn't name, would sweep every hidden
  // project to the bottom the first time you reorder the visible ones.
  function commitOrder(ids: string[]) {
    if (ids.every((id, i) => ordered[i]?.id === id)) return
    void reorderProjects(expandOrder(allOrdered, ids))
  }

  // Keyboard/touch reorder: move a project one slot up or down.
  function nudgeProject(id: string, delta: -1 | 1) {
    const from = ordered.findIndex((p) => p.id === id)
    const to = from + delta
    if (from < 0 || to < firstMovable || to >= ordered.length) return
    const ids = ordered.map((p) => p.id)
    ids.splice(to, 0, ids.splice(from, 1)[0])
    commitOrder(ids)
  }

  function handleRowDragOver(e: React.DragEvent, index: number) {
    if (dragId == null) return
    e.preventDefault() // without this the row is not a drop target at all
    e.dataTransfer.dropEffect = 'move'
    // Past the middle of a row means "after it".
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    setDropIndex(Math.max(firstMovable, Math.min(ordered.length, index + (after ? 1 : 0))))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    if (dragId != null && dropIndex != null) commitOrder(moveProject(ordered, dragId, dropIndex))
    setDragId(null)
    setDropIndex(null)
  }

  // Unregister a project. Non-destructive (nothing on disk is touched), but it
  // stops the project's services and takes it off every device's list, so it
  // asks first - the same confirmation and copy as the Settings danger zone,
  // which is the other place this lives.
  function confirmRemove(p: ProjectInfo) {
    useDialogStore.getState().show({
      title: 'Remove project',
      message: `Remove "${p.name}" from Hydra? Your files, git history and existing agents are all kept - re-adding the folder brings them back. Only the project's background services are stopped.`,
      type: 'warning',
      confirmLabel: 'Remove project',
      showCancel: true,
      onConfirm: () => { void removeProject(p) },
    })
  }

  async function removeProject(p: ProjectInfo) {
    try {
      await api.default.removeProject(p.id)
      const store = useProjectStore.getState()
      store.setProjects(store.projects.filter((x) => x.id !== p.id))
      useToastStore.getState().show({ message: pillText`Removed "${p.name}" from Hydra.`, type: 'success' })
      // Removing the project you're looking at leaves the page pointing at
      // nothing - hand back to the caller's deselect, which navigates away.
      if (selectedId === p.id) onDeselect()
    } catch (err) {
      useDialogStore.getState().show({
        title: 'Remove failed',
        message: `Failed to remove project: ${formatError(err)}`,
        type: 'error',
      })
    }
  }

  return (
    <div ref={triggerRef} className="relative shrink-0">
      <button
        aria-label="Select project"
        onClick={() => { setOpen((o) => !o); setShowAddInput(false); setAddError(null); clearDrag() }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs cursor-pointer"
      >
        <span className="relative shrink-0 inline-flex">
          {/* The project icon leads the global top bar, standing in for the
              removed app logo (20px - 24 read too heavy in the bar). */}
          <ProjectIcon icon={selected?.icon} projectId={selected?.id ?? ''} size={20} />
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
        {/* On small screens the selector is just the icon + chevron. */}
        <span className="truncate max-w-[160px] max-md:hidden">{selected?.name ?? 'Select project'}</span>
        <ServiceHealthWarning projectId={selectedId} />
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && coords && createPortal(
        <div
          ref={menuRef}
          style={{ left: coords.left, top: coords.top, bottom: coords.bottom }}
          className="fixed w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-[9999] max-h-[70vh] overflow-y-auto animate-popover-in"
        >
          {projects.length > 0 && (
            <div
              className="py-1 border-b border-gray-100 dark:border-gray-700"
              // Leaving the list mid-drag drops the indicator, so a drag that
              // ends outside doesn't look like it will land somewhere.
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null)
              }}
            >
              {/* Built-ins (the scratch project) are pinned above the user's own
                  projects and kept out of any reordering, so their position is
                  muscle-memory stable. The rest are in the user's own order -
                  drag a row (or use the grip's up/down arrows) to change it. */}
              {ordered.map((p, i) => (
                <div
                  key={p.id}
                  className="relative"
                  onDragOver={(e) => handleRowDragOver(e, i)}
                  onDrop={handleDrop}
                >
                  {/* Insertion line. Absolutely positioned so showing it doesn't
                      shift the rows the user is aiming at. */}
                  {dropIndex === i && (
                    <div className="absolute left-2 right-2 -top-px h-0.5 rounded-full bg-blue-500 z-10" />
                  )}
                  {dropIndex === ordered.length && i === ordered.length - 1 && (
                    <div className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-blue-500 z-10" />
                  )}
                  <ProjectRow
                    project={p}
                    selected={p.id === selectedId}
                    editing={editing}
                    onClick={() => {
                      // Edit mode is for arranging the list, not leaving it.
                      if (editing) return
                      if (p.id === selectedId) {
                        onDeselect()
                      } else {
                        onSelect(p.id)
                      }
                      setOpen(false)
                    }}
                    // Hiding is offered for every project, built-ins included:
                    // the scratch project is exactly the one some people never
                    // use, and unlike removal it costs nothing to undo.
                    onToggleHidden={() => { void setProjectHidden(p.id, !p.hidden) }}
                    onRemove={p.builtin ? undefined : () => confirmRemove(p)}
                    // Touch has no drag, so its up/down pair only exists in edit
                    // mode; a mouse can always drag, handle or no handle.
                    reorder={canReorder && !p.builtin && (finePointer || editing) ? {
                      dragging: dragId === p.id,
                      finePointer,
                      canMoveUp: i > firstMovable,
                      canMoveDown: i < ordered.length - 1,
                      onMove: (delta) => nudgeProject(p.id, delta),
                      onDragStart: (e) => {
                        // Firefox refuses to start a drag with no payload.
                        e.dataTransfer.setData('text/plain', p.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragId(p.id)
                        setDropIndex(i)
                      },
                      onDragEnd: () => { setDragId(null); setDropIndex(null) },
                    } : undefined}
                  />
                  {p.builtin && !ordered[i + 1]?.builtin && ordered[i + 1] && (
                    <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
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
                  {browsing ? 'Waiting for folder...' : 'Browse...'}
                </button>
                {addError && (
                  <p className="text-3xs text-red-500 px-3 pb-1 leading-snug">{addError}</p>
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
                  placeholder="~/code/project or /absolute/path"
                  disabled={adding}
                  className="w-full text-xs font-mono px-2 py-1.5 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-500 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500 disabled:opacity-50"
                />
                {/* Where that lands. Shown whenever it differs from what was
                    typed, so "~/x" and relative paths make it obvious which
                    folder is about to be opened before the trust prompt. */}
                {resolved?.input === newPath.trim() && resolved.result.path !== newPath.trim() && (
                  <p className="text-3xs font-mono text-gray-500 dark:text-gray-400 mt-1 leading-snug break-all">{resolved.result.path}</p>
                )}
                {resolved?.input === newPath.trim() && pathHint(resolved.result) && (
                  <p className="text-3xs text-amber-600 dark:text-amber-500 mt-0.5 leading-snug">{pathHint(resolved.result)}</p>
                )}
                {addError && (
                  <p className="text-3xs text-red-500 mt-1 leading-snug">{addError}</p>
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
                    onClick={() => { setShowAddInput(false); setNewPath(''); setResolved(null); setAddError(null) }}
                    className="text-xs py-1 px-2 rounded border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {/* Arrange mode. Reordering and removing are both occasional jobs,
                so they live behind this rather than as hover affordances on
                every row - the hover "x" this menu used to have was too easy to
                hit by accident, which is why removal moved to Settings. */}
            {canEditList && !showAddInput && (
              <button
                onClick={() => { setEditing((v) => !v); setDragId(null); setDropIndex(null) }}
                className={`w-full flex items-center gap-2 px-3 py-2 cursor-pointer text-left text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 ${
                  editing
                    ? 'text-blue-600 dark:text-blue-400 font-medium'
                    : 'text-gray-600 dark:text-gray-400'
                }`}
              >
                {editing ? <Check className="w-3 h-3" /> : <Pencil className="w-3 h-3" />}
                {editing ? 'Done' : 'Edit list'}
              </button>
            )}
          </div>

          {/* In edit mode the footer explains the mode instead of the switch
              shortcut - notably that removing a project is not destructive. */}
          {editing ? (
            <div className="px-3 py-1.5 border-t border-gray-100 dark:border-gray-700 text-3xs text-gray-400 dark:text-gray-500 leading-snug">
              {canReorder ? (finePointer ? 'Drag a project to reorder it. ' : 'Use the arrows to reorder. ') : ''}
              The eye hides a project from this list and the Ctrl+` switcher; removing takes it off this
              list entirely - either way your files stay put.
            </div>
          ) : projects.length > 1 && finePointer && (
            <div className="px-3 py-1.5 border-t border-gray-100 dark:border-gray-700 text-3xs text-gray-400 dark:text-gray-500 font-mono">
              {SWITCH_PROJECT_HINT}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
})
