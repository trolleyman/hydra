// Centralized keyboard-shortcut definitions and helpers. This registry is the
// single source of truth for the help overlay (KeyboardShortcutsModal) and for
// the lowlit shortcut hints shown next to menu items; the actual key handling
// lives with each feature (project switch + `?` in __root.tsx, agent actions in
// AgentDetail.tsx) since that's where the relevant state and callbacks are.

// macOS uses ⌘ as the primary action modifier; everywhere else it's Ctrl. We
// detect once at module load. navigator.platform is the reliable signal; the UA
// is a fallback for browsers that have started hiding platform.
export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')

// Display label for the primary modifier (⌘ on macOS, Ctrl elsewhere).
export const modLabel = isMac ? '⌘' : 'Ctrl'

// True when the event's primary modifier is held: ⌘ on macOS, Ctrl elsewhere.
// Lets a binding be ⌘M on a Mac and Ctrl+M on Linux/Windows from one check.
export function hasMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

// Whether a keystroke is being typed into an editable surface — a form field, a
// contenteditable, or the xterm terminal. App shortcuts defer to these so we
// never steal a character the user meant to type (in a terminal Ctrl+M is Enter,
// Ctrl+U kills the line, `?` is just a question mark, etc.).
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  if (typeof el.closest === 'function' && el.closest('.xterm')) return true
  return false
}

export interface ShortcutDef {
  // Display tokens, joined with a thin gap by the renderer (e.g. ['⌘', 'M']).
  keys: string[]
  label: string
}

export interface ShortcutGroup {
  title: string
  shortcuts: ShortcutDef[]
}

// The catalogue rendered by the help overlay. Display tokens only — handling
// lives with each feature. Ctrl+` is Ctrl on every platform (macOS reserves ⌘`
// for its own window cycling), so it's spelled out rather than using modLabel.
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], label: 'Show keyboard shortcuts' },
      { keys: [modLabel, '.'], label: 'Toggle sidebar' },
      { keys: ['Ctrl', '`'], label: 'Switch to next project' },
      { keys: ['Ctrl', '⇧', '`'], label: 'Switch to previous project' },
    ],
  },
  {
    title: 'Agent',
    shortcuts: [
      { keys: [modLabel, 'J'], label: 'Next agent' },
      { keys: [modLabel, 'K'], label: 'Previous agent' },
      { keys: [modLabel, 'M'], label: 'Merge agent' },
      { keys: [modLabel, 'U'], label: 'Mark as unread' },
    ],
  },
]

// Compact display strings for the lowlit hints shown next to menu items.
export const SHORTCUT_MERGE = `${modLabel}M`
export const SHORTCUT_MARK_UNREAD = `${modLabel}U`
