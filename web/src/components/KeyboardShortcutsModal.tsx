import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'
import { IconButton } from './IconButton'

// A single key rendered as a lowlit keycap.
function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 text-[11px] font-medium text-gray-500 dark:text-gray-400">
      {children}
    </kbd>
  )
}

// The keyboard-shortcuts help overlay (opened with `?`, the footer button, or
// useShortcutsStore.setOpen). Lists every shortcut from the central registry so
// it stays in sync with the hints shown next to menu items.
export function KeyboardShortcutsModal() {
  const open = useShortcutsStore((s) => s.open)
  const setOpen = useShortcutsStore((s) => s.setOpen)

  // Escape closes it. `?` toggling is owned by the global handler in __root.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      // z-[120]: a focused modal sits ABOVE the approval toasts (z-[110]).
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h3 id="shortcuts-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Keyboard shortcuts
          </h3>
          <IconButton onClick={() => setOpen(false)} aria-label="Close">
            <X className="w-5 h-5" />
          </IconButton>
        </div>

        <div className="px-6 py-4 max-h-[70vh] overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="mb-5 last:mb-0">
              <div className="text-[11px] font-semibold tracking-wide text-gray-400 dark:text-gray-500 mb-2">
                {group.title}
              </div>
              <div className="space-y-1.5">
                {group.shortcuts.map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gray-700 dark:text-gray-300">{s.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, i) => (
                        <Key key={i}>{k}</Key>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
