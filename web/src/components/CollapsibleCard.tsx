import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useMeasuredHeight } from '../lib/useMeasuredHeight'

// The card header's action buttons (build log / regenerate / re-run) sit as faint
// icons at rest and brighten ONLY the icon the pointer is actually over — a
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
// hosts `actions` — the melt-style icon buttons (see MELT_BTN). The body renders
// below the header only while expanded, in the same `px-3 pb-2` inset both panels
// rely on. Every state lives inside the one bordered card so toggling between them
// never shifts the layout and the action buttons stay reachable.
//
// With `sticky`, the header pins itself flush below the panel's section bar while
// the card body scrolls under it, releasing when the card ends (see STICKY_CARD_TOP).
// The header then needs its own overflow-hidden + rounding (the root drops its
// overflow-hidden, which would otherwise trap the sticky header inside the card),
// and an opaque resting tint so the scrolling body doesn't show through.
//
// Expand/collapse is animated: the chevron rotates a quarter-turn and the body
// glides between 0 and its measured height. Because the height tracks the live
// content height (a ResizeObserver via useMeasuredHeight), in-place content swaps
// while open — toggling the build log, a grid collapsing to "No files match …" —
// glide too instead of snapping. The body stays MOUNTED only while open (plus the
// brief collapse animation), so a collapsed card never pays to render its heavy
// children (xterm logs, image grids); see `mounted` below.
export function CollapsibleCard({ icon, name, status, actions, collapsed, onToggleCollapsed, children, sticky = false }: {
  icon: ReactNode
  name: ReactNode
  // Inline chips/summary shown after the name, inside the collapse button.
  status?: ReactNode
  // Right-aligned action buttons (melt icons); omit for a card with no actions.
  actions?: ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
  children?: ReactNode
  // Pin the header beneath the panel's section bar while the body scrolls.
  sticky?: boolean
}) {
  const [bodyRef, bodyH] = useMeasuredHeight(0)
  // `mounted` keeps the body in the tree while open and for the length of a collapse
  // animation, then drops it so a collapsed card stays cheap. Expanding mounts at
  // once (in an effect, after a paint at height 0) so the 0→height glide can play.
  const [mounted, setMounted] = useState(!collapsed)
  useEffect(() => {
    if (!collapsed) {
      // Mount deliberately in an effect (after a paint at height 0), NOT during
      // render, so the 0→height glide can play; mounting synchronously would jump
      // straight to the measured height. This post-paint setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [collapsed])
  const open = !collapsed && mounted
  return (
    <div className={`border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 ${sticky ? '' : 'overflow-hidden'}`}>
      <div
        style={sticky ? { top: STICKY_CARD_TOP } : undefined}
        className={
          sticky
            ? `sticky z-10 flex items-stretch overflow-hidden bg-gray-100 dark:bg-gray-700 rounded-t-lg ${collapsed ? 'rounded-b-lg' : ''}`
            : 'flex items-stretch bg-gray-100 dark:bg-gray-700/40'
        }
      >
        <button
          onClick={onToggleCollapsed}
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
      </div>
      {/* Height tracks the measured content so both expand/collapse and in-place
          content swaps glide; overflow-hidden clips the body as it grows/shrinks.
          `isolate` traps the body's positioned content (artifact tiles render the
          images as `absolute inset-0`, and the compare slider has an `absolute
          z-10` handle) in its own stacking context, so it can never paint over the
          sticky section/changes bars above it — some mobile browsers otherwise
          mis-order those leaked positioned layers against `position: sticky`
          during image-decode repaints. */}
      <div
        className="isolate overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
        style={{ height: open ? bodyH : 0 }}
        aria-hidden={!open}
      >
        {mounted && <div ref={bodyRef} className="px-3 pb-2">{children}</div>}
      </div>
    </div>
  )
}
