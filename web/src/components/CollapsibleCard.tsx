import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useMeasuredHeight } from '../lib/useMeasuredHeight'
import { pinCardToTop } from '../lib/diffScroll'

// The card header's action buttons (build log / regenerate / re-run) sit as faint
// icons at rest and brighten ONLY the icon the pointer is actually over - a
// per-button `hover:` (not a shared `group-hover:`), with no border or background.
// So hovering one button no longer lights up its neighbour or boxes the whole
// cluster; it just darkens that one icon. MELT_BTN is the shared resting+hover
// skin; per-button classes add the rounding/layout on top.
export const MELT_BTN = 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors cursor-pointer'

// The sticky `top` for a card header: it docks flush below its panel's section bar,
// which itself docks below the Changes toolbar. Both heights arrive as CSS vars
// (--sticky-changes-h from DiffViewer, --sticky-section-h from the panel); the -16px
// cancels the scroll container's pt-4 (which the Changes bar offsets with -top-4).
export const STICKY_CARD_TOP = 'calc(var(--sticky-changes-h, 45px) + var(--sticky-section-h, 41px) - 16px)'

// How long the expand/collapse height glide (and the chevron's quarter-turn) runs.
// Kept in JS too so the unmount-after-collapse timer matches the CSS duration.
const COLLAPSE_MS = 200

// CollapsibleCard is the shared bordered card used by both the artifacts panel and
// the tests panel (PLAN #68): a header row whose left half is a click-to-collapse
// button (chevron + icon + name + an inline `status` slot) and whose right half
// hosts `actions` - the melt-style icon buttons (see MELT_BTN). The body renders
// below the header only while expanded, in the same symmetric `p-3` inset both
// panels rely on - so a body child (a log terminal, an image grid) sits with equal
// breathing room on all four sides. Full-bleed rows opt out with `-mx-3`.
// Every state lives inside the one bordered card so toggling between them
// never shifts the layout and the action buttons stay reachable.
//
// With `sticky`, the header pins itself flush below the panel's section bar while
// the card body scrolls under it, releasing when the card ends (see STICKY_CARD_TOP).
// The header then needs its own overflow-hidden + rounding (the root drops its
// overflow-hidden, which would otherwise trap the sticky header inside the card),
// and an opaque resting tint so the scrolling body doesn't show through.
//
// Expand/collapse GLIDES: the chevron rotates a quarter-turn and the body glides
// between 0 and its measured height. The height glide is armed ONLY around a card
// collapse/expand toggle (see `heightAnimated`): it is off on the first render - so
// a card that mounts already-expanded (restored view prefs, or an agent switch
// remounting it) snaps straight to its open height rather than animating itself open
// - and off again once a toggle's glide has finished. Both the arm and the height
// target move (see `expanded`) happen in one post-toggle commit, so the height only
// ever changes with the transition already in place - a close otherwise snaps, since
// `collapsed` flips a commit earlier than the glide could arm. That last part matters: while
// the card sits open its body height MIRRORS its measured content instantly, so a
// nested expand (a result section or a tree node running its OWN grid-row glide)
// animates alone instead of being double-animated. With the glide always on, the
// card eased toward a target that was itself easing, so its height visibly lagged
// the very content it framed. The body stays MOUNTED only while open (plus the brief
// collapse animation), so a collapsed card never pays to render its heavy children
// (xterm logs, image grids); see `mounted` below.
export function CollapsibleCard({ icon, name, status, actions, progress, collapsed, onToggleCollapsed, children, sticky = false, glideKey }: {
  icon: ReactNode
  name: ReactNode
  // Inline chips/summary shown after the name, inside the collapse button.
  status?: ReactNode
  // Right-aligned action buttons (melt icons); omit for a card with no actions.
  actions?: ReactNode
  // A thin progress FILL (a determinate `width` bar or an indeterminate barber
  // pole) drawn as a loading line pinned to the header's BOTTOM EDGE - out of flow,
  // so it never shifts the body and shows whether the card is collapsed or open. The
  // card owns the track (height/tint/clip to the rounded corners); the caller supplies
  // only the fill. Omit for a card that isn't working.
  progress?: ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
  children?: ReactNode
  // Pin the header beneath the panel's section bar while the body scrolls.
  sticky?: boolean
  // Bump this whenever a deliberate in-place content swap changes the body height
  // in one step (e.g. showing/hiding the build log) and you want that height change
  // to GLIDE rather than snap. Changing it arms the height transition for one window,
  // exactly like a card toggle does. Nested expands that animate their own height
  // (result sections, tree nodes) must NOT touch this - leaving them to mirror the
  // card height instantly is what keeps them from being double-animated.
  glideKey?: string | number | boolean
}) {
  const [bodyRef, bodyH] = useMeasuredHeight(0)
  // `mounted` keeps the body in the tree while open and for the length of a collapse
  // animation, then drops it so a collapsed card stays cheap. A user expand mounts it
  // in an effect (after a paint at height 0) so the 0->height glide can play.
  const [mounted, setMounted] = useState(!collapsed)
  // `expanded` is the body's height TARGET (bodyH when true, 0 when false). It mirrors
  // `collapsed` but lags a toggle by one commit: the arm effect below flips it in the
  // SAME commit that arms `heightAnimated`, so the height only ever moves while the
  // transition class is already present. Driving the height straight off `collapsed`
  // snapped the close - `collapsed` flips during the click's render, so the body hit 0
  // one commit before the glide could arm and there was nothing left to ease. (Expand
  // never had this problem: its height change is deferred by the `mounted` effect, so
  // it already landed together with the arm.)
  const [expanded, setExpanded] = useState(!collapsed)
  // `heightAnimated` arms the body-height glide, and ONLY the card's own collapse or
  // expand (or a caller-signalled `glideKey` swap) should glide - see the block comment
  // above. It is false on the first render (so a restored-open card snaps rather than
  // self-glides) and is pulsed true for one COLLAPSE_MS window each time `collapsed`/
  // `glideKey` changes; the rest of the time it stays false, so steady-open resizes (a
  // nested section/tree-node expand) mirror instantly and animate alone. Because the
  // ref measures the body height in-commit (before the first paint), the opening snap
  // lands on the real height, not a flash at 0.
  const [heightAnimated, setHeightAnimated] = useState(false)
  const firstToggle = useRef(true)
  useEffect(() => {
    // Skip the mount fire - only a real collapse/expand toggle (or a caller-signalled
    // `glideKey` content swap) arms the glide.
    if (firstToggle.current) {
      firstToggle.current = false
      return
    }
    // Arm the glide and move the height target together, in this one post-toggle
    // commit, so the body eases toward the new height instead of jumping to it before
    // the transition exists.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeightAnimated(true)
    setExpanded(!collapsed)
    const t = setTimeout(() => setHeightAnimated(false), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [collapsed, glideKey])
  useEffect(() => {
    if (!collapsed) {
      // Mount deliberately in an effect (after a paint at height 0), NOT during
      // render, so a user expand's 0->height glide can play. On the first render the
      // body is already mounted (useState above) with animate still false, so a
      // restore snaps open instead of gliding. This post-paint setState is intended.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [collapsed])
  const open = expanded && mounted
  const rootRef = useRef<HTMLDivElement>(null)
  // Collapsing a card whose top has scrolled above the viewport would leave the
  // scroll at a random depth of whatever content replaces the folded body -
  // pin the (now short) card to the top instead, docked under the sticky
  // chrome (see pinCardToTop for why it's a pin, not a one-shot scroll).
  const handleToggle = () => {
    if (!collapsed && rootRef.current) pinCardToTop(rootRef.current)
    onToggleCollapsed()
  }
  return (
    <div
      ref={rootRef}
      style={{ scrollMarginTop: `calc(${STICKY_CARD_TOP} + 8px)` }}
      className={`border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 ${sticky ? '' : 'overflow-hidden'}`}
    >
      <div
        style={sticky ? { top: STICKY_CARD_TOP } : undefined}
        className={
          sticky
            ? `sticky z-10 flex items-stretch overflow-hidden bg-gray-100 dark:bg-gray-700 rounded-t-lg ${collapsed ? 'rounded-b-lg' : ''}`
            : 'relative flex items-stretch bg-gray-100 dark:bg-gray-700/40'
        }
      >
        <button
          onClick={handleToggle}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
        >
          <ChevronDown className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`} />
          {icon}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate shrink-0">{name}</span>
          {status}
        </button>
        {/* Faint icon buttons, vertically centred in the stretch-height header.
            Each brightens only on its own hover (see MELT_BTN). */}
        {actions && <div className="shrink-0 flex items-center gap-1.5 pl-1 pr-2">{actions}</div>}
        {/* Progress: a loading line on the header's bottom edge. Absolute so it
            never adds height to the header/body, and lives in the always-rendered
            header so it shows while the card is collapsed too. The header's
            overflow-hidden (sticky) or the card root's (non-sticky) clips it to the
            rounded corners. */}
        {progress && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-gray-200 dark:bg-gray-600/60">
            {progress}
          </div>
        )}
      </div>
      {/* Height tracks the measured content: the body glides between 0 and its
          height on a user expand/collapse, and otherwise mirrors its content's
          height instantly (so a nested section/tree-node expand animates on its own
          without the card double-easing behind it); overflow-hidden clips the body
          as it grows/shrinks. The transition is gated on `heightAnimated`, so it's
          absent on the first render and between toggles - a restored-expanded card
          snaps open instead of gliding itself open.
          `isolate` traps the body's positioned content (artifact tiles render the
          images as `absolute inset-0`, and the compare slider has an `absolute
          z-10` handle) in its own stacking context, so it can never paint over the
          sticky section/changes bars above it - some mobile browsers otherwise
          mis-order those leaked positioned layers against `position: sticky`
          during image-decode repaints. */}
      <div
        className={`isolate overflow-hidden ${heightAnimated ? 'transition-[height] duration-200 ease-out motion-reduce:transition-none' : ''}`}
        style={{ height: open ? bodyH : 0 }}
        aria-hidden={!open}
      >
        {mounted && <div ref={bodyRef} className="p-3">{children}</div>}
      </div>
    </div>
  )
}
