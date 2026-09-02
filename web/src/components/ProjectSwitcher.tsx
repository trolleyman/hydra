import { useEffect, useRef } from 'react'
import type { SwitcherState } from '../lib/useGlobalShortcuts'
import { ProjectIcon } from '../lib/projectIcon'
import { ProjectAgentCounts, ProjectAttentionDot } from './ProjectAgentCounts'

// The centered alt-tab-style project switcher overlay. Rendered by RootLayout
// while Ctrl+` is held (state owned by useGlobalShortcuts): it lists projects in
// last-visited order and highlights the one that will be committed when Ctrl is
// released. Purely presentational - all key handling lives in the hook.
export function ProjectSwitcher({
  state,
  onHover,
  onSelect,
}: {
  state: SwitcherState | null
  // Hovering a row moves the highlight; clicking one commits that project.
  onHover?: (index: number) => void
  onSelect?: (id: string) => void
}) {
  const activeRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view as the user cycles through a long list.
  useEffect(() => {
    if (state) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [state])

  if (!state) return null
  const { items, index } = state

  return (
    <div
      // z-[120]: sits above the approval toasts (z-[110]), like the shortcuts modal.
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-label="Switch project"
      >
        <div className="px-5 pt-4 pb-2 text-2xs font-semibold tracking-wide text-gray-400 dark:text-gray-500">
          Switch project
        </div>
        <div className="px-2 pb-2 max-h-[60vh] overflow-y-auto">
          {items.map((p, i) => {
            const active = i === index
            return (
              <div
                key={p.id}
                ref={active ? activeRef : undefined}
                onMouseEnter={() => onHover?.(i)}
                onClick={() => onSelect?.(p.id)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer ${
                  active ? 'bg-blue-500 text-white' : 'text-gray-700 dark:text-gray-200'
                }`}
              >
                <span className={`relative shrink-0 inline-flex ${active ? '' : 'text-gray-400'}`}>
                  <ProjectIcon icon={p.icon} projectId={p.id} size={20} />
                  <ProjectAttentionDot
                    project={p}
                    className={`absolute -right-0.5 -bottom-0.5 ring-2 ${active ? 'ring-blue-500' : 'ring-white dark:ring-gray-800'}`}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center min-w-0">
                    <span className="text-sm font-medium truncate">{p.name}</span>
                  </div>
                  {/* Built-ins have no meaningful path to show - same as the
                      project dropdown, the second line is omitted. */}
                  {!p.builtin && (
                    <div className={`text-xs font-mono truncate ${active ? 'text-blue-100' : 'text-gray-400 dark:text-gray-500'}`}>
                      {p.path}
                    </div>
                  )}
                </div>
                {/* Per-project agent tally, matching the sidebar project
                    dropdown: a colored dot+count per non-zero status. onAccent
                    keeps the numbers readable on the highlighted row's blue
                    fill. */}
                <ProjectAgentCounts project={p} onAccent={active} className="shrink-0" />
              </div>
            )
          })}
        </div>
        <div className="px-5 py-2.5 border-t border-gray-100 dark:border-gray-700 text-3xs text-gray-400 dark:text-gray-500 font-mono">
          Hold Ctrl, tap ` to cycle - Shift+` back - release Ctrl to switch
        </div>
      </div>
    </div>
  )
}
