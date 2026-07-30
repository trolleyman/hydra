import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { Bot, GitBranch, ChevronDown, Check } from 'lucide-react'
import type { RepositoryBranch } from '../api'
import { Tooltip } from './Tooltip'

// shortSha collapses a full/long commit SHA to a readable prefix, leaving
// branch names (and anything that isn't a hex SHA) untouched.
function shortSha(ref: string): string {
  return /^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 8) : ref
}

// BranchSelector is a dropdown for picking a branch (or showing a detached
// commit). It is shared between the repository view's branch switcher and the
// agent detail header's base-branch editor. `activeRef` is the currently
// selected branch/commit; `isKnownBranch` says whether it appears in `branches`
// (so a bare commit SHA renders as a short SHA rather than a missing branch).
// memo: hosted in the spawn composer (re-renders per keystroke) and the agent
// header (re-renders per live status tick); its props are stable across both.
export const BranchSelector = memo(function BranchSelector({
  branches, activeRef, isKnownBranch, onSelect, title = 'Switch branch',
  triggerIcon: TriggerIcon, triggerActive = false, flexible = false, fitContent = false,
  onOpen,
}: {
  branches: RepositoryBranch[]
  activeRef: string
  isKnownBranch: boolean
  onSelect: (name: string) => void
  title?: string
  // Called each time the dropdown is opened. Used to kick off a background
  // refresh of `branches` so newly-created branches (e.g. a just-spawned agent
  // branch) appear without reloading the page. The cached `branches` stay
  // visible while the refresh is in flight.
  onOpen?: () => void
  // When set, the trigger renders as a single icon button (no branch label),
  // used by the repository diff view to start a comparison. `triggerActive`
  // paints it in the active/selected state even while closed.
  triggerIcon?: ComponentType<{ className?: string }>
  triggerActive?: boolean
  // When true the control may shrink to share a row and clips its branch name
  // (instead of sizing to its content) - used for the diff view's base → head
  // selector pair in the narrow repository sidebar.
  flexible?: boolean
  // When true the trigger sizes to its branch name (compact for short names
  // like "main") but still caps at its container's width and truncates longer
  // names - used inside the narrow spawn-options popover.
  fitContent?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // The dropdown is rendered in a portal so it escapes ancestors that clip
  // overflow (notably the spawn box's `overflow-hidden` card, which otherwise
  // swallows it entirely). We position it manually from the trigger's rect and
  // flip it above the trigger when there isn't room below.
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const MENU_WIDTH = 256 // w-64
  const MENU_MAX_HEIGHT = 320 // max-h-80
  const GAP = 4 // mt-1

  const updateCoords = () => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const padding = 8
    let left = rect.left
    if (left + MENU_WIDTH > window.innerWidth - padding) {
      left = Math.max(padding, window.innerWidth - MENU_WIDTH - padding)
    }
    const spaceBelow = window.innerHeight - rect.bottom
    // Flip above when there isn't room below but there is above.
    if (spaceBelow < MENU_MAX_HEIGHT && rect.top > spaceBelow) {
      setCoords({ left, bottom: window.innerHeight - rect.top + GAP })
    } else {
      setCoords({ left, top: rect.bottom + GAP })
    }
  }

  useLayoutEffect(() => {
    // No reset on close: the menu is only rendered while `open` (see the
    // `open && coords` guard below), and updateCoords recomputes fresh
    // coordinates synchronously - before paint - on the next open.
    if (!open) return
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
      if (ref.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Kick off a background refresh whenever the menu opens, so the list reflects
  // branches created since the page (or this component) last loaded.
  useEffect(() => {
    if (open) onOpen?.()
    // onOpen is intentionally omitted: callers pass an inline closure that would
    // re-fire this on every render. We only want it on the open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The current (HEAD) branch is surfaced in its own unnamed section at the top,
  // so it's excluded from the agent/other lists below (and their counts).
  const current = branches.find((b) => b.is_current)
  const agentBranches = branches.filter((b) => b.is_agent && !b.is_current)
  const otherBranches = branches.filter((b) => !b.is_agent && !b.is_current)

  // The label trigger mirrors the rows: when the selected branch is an agent
  // branch, show the purple Bot icon instead of the generic branch icon.
  const activeIsAgent = branches.some((b) => b.name === activeRef && b.is_agent)

  const Row = ({ b }: { b: RepositoryBranch }) => (
    <button
      type="button"
      onClick={() => { onSelect(b.name); setOpen(false) }}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
    >
      {b.is_agent ? <Bot className="w-3.5 h-3.5 shrink-0 text-purple-500" /> : <GitBranch className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
      <span className="truncate font-mono">{b.name}</span>
      {b.is_current && <span className="ml-1 text-4xs px-1 py-px rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 shrink-0">HEAD</span>}
      {b.name === activeRef && <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-blue-500" />}
    </button>
  )

  // Width behaviour of the labelled trigger: `flexible` fills its row and clips;
  // `fitContent` sizes to the branch name but caps at the container and clips;
  // otherwise it sizes to content up to a fixed cap.
  const wrapperSize = flexible ? 'min-w-0 flex-1' : fitContent ? 'w-fit max-w-full min-w-0' : 'shrink-0'
  const triggerSize = flexible ? 'w-full min-w-0' : fitContent ? 'w-fit max-w-full min-w-0' : 'max-w-[14rem]'

  return (
    // `flex` so the Tooltip's inline-flex wrapper around the trigger is a flex
    // item rather than an inline box - an inline box would sit on this line's
    // baseline and add a few px of descender space under the control.
    <div ref={ref} className={`relative flex ${wrapperSize}`}>
      {TriggerIcon ? (
        <Tooltip content={title} className="shrink-0">
          <button
            type="button"
            aria-label={title}
            onClick={() => setOpen((o) => !o)}
            className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer shrink-0 ${open || triggerActive
              ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
              : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
          >
            <TriggerIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      ) : (
        // The width constraints are on the wrapper too: the button's `w-full` /
        // `max-w-[14rem]` now resolve against the wrapper, not this box.
        <Tooltip content={title} className={triggerSize}>
          <button
            type="button"
            // A stable hook for the screenshot/e2e scripts. This trigger's only
            // other identity is its icon and its branch name, and both move:
            // keying on `title="Switch branch"` broke when the tooltip convention
            // replaced the native title, and keying on a lucide class broke when
            // GitCompare became GitCompareArrows. Same idea as data-main-scroll.
            data-branch-selector=""
            onClick={() => setOpen((o) => !o)}
            // h-7 rather than py-1: this trigger sits in a row with the
            // options popovers and the terminal/chat toggle, which are h-7, and
            // arriving at 27px from padding read as a misalignment.
            className={`flex h-7 items-center gap-1.5 px-2.5 rounded-md border text-xs font-medium transition-colors cursor-pointer ${triggerSize} ${open
              ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
              : 'text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
          >
            {activeIsAgent
              ? <Bot className="w-3.5 h-3.5 shrink-0 text-purple-500" />
              : <GitBranch className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate font-mono">{isKnownBranch ? activeRef : shortSha(activeRef)}</span>
            <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
          </button>
        </Tooltip>
      )}

      {open && coords && createPortal(
        <div
          ref={menuRef}
          data-portal-menu
          className="fixed w-64 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-[9999] py-1"
          style={{ left: coords.left, top: coords.top, bottom: coords.bottom }}
        >
          {!isKnownBranch && activeRef && (
            <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
              <Check className="w-3.5 h-3.5 shrink-0 text-blue-500" />
              <span className="truncate font-mono">{shortSha(activeRef)}</span>
              <span className="ml-auto text-3xs">Commit</span>
            </div>
          )}
          {current && (
            <>
              <Row b={current} />
              {(agentBranches.length > 0 || otherBranches.length > 0) && (
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
              )}
            </>
          )}
          {agentBranches.length > 0 && (
            <>
              <p className="px-2 pt-1.5 pb-1 text-3xs font-semibold text-gray-400 dark:text-gray-500">Agent branches · {agentBranches.length}</p>
              {agentBranches.map((b) => <Row key={b.name} b={b} />)}
            </>
          )}
          {otherBranches.length > 0 && (
            <>
              <p className="px-2 pt-2 pb-1 text-3xs font-semibold text-gray-400 dark:text-gray-500">Other branches · {otherBranches.length}</p>
              {otherBranches.map((b) => <Row key={b.name} b={b} />)}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
})
