import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

// The card header's action buttons (build log / regenerate / re-run) sit as faint
// icons at rest and brighten ONLY the icon the pointer is actually over — a
// per-button `hover:` (not a shared `group-hover:`), with no border or background.
// So hovering one button no longer lights up its neighbour or boxes the whole
// cluster; it just darkens that one icon. MELT_BTN is the shared resting+hover
// skin; per-button classes add the rounding/layout on top.
export const MELT_BTN = 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors cursor-pointer'

// CollapsibleCard is the shared bordered card used by both the artifacts panel and
// the tests panel (PLAN #68): a header row whose left half is a click-to-collapse
// button (chevron + icon + name + an inline `status` slot) and whose right half
// hosts `actions` — the melt-style icon buttons (see MELT_BTN). The body renders
// below the header only while expanded, in the same `px-3 pb-2` inset both panels
// rely on. Every state lives inside the one bordered card so toggling between them
// never shifts the layout and the action buttons stay reachable.
export function CollapsibleCard({ icon, name, status, actions, collapsed, onToggleCollapsed, children }: {
  icon: ReactNode
  name: ReactNode
  // Inline chips/summary shown after the name, inside the collapse button.
  status?: ReactNode
  // Right-aligned action buttons (melt icons); omit for a card with no actions.
  actions?: ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
  children?: ReactNode
}) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      {/* Give the header a resting tint that's distinct from the card body
          (bg-white / dark:bg-gray-800) on its own, not only on hover. */}
      <div className="flex items-stretch bg-gray-100 dark:bg-gray-700/40">
        <button
          onClick={onToggleCollapsed}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
          {icon}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate shrink-0">{name}</span>
          {status}
        </button>
        {/* Faint icon buttons, vertically centred in the stretch-height header.
            Each brightens only on its own hover (see MELT_BTN). */}
        {actions && <div className="shrink-0 flex items-center gap-1.5 pl-1 pr-2">{actions}</div>}
      </div>
      {!collapsed && <div className="px-3 pb-2">{children}</div>}
    </div>
  )
}
