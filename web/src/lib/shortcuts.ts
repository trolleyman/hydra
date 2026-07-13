// Centralized keyboard-shortcut definitions and helpers. This registry is the
// single source of truth for the help overlay (KeyboardShortcutsModal) and for
// the lowlit shortcut hints shown next to menu items; the actual key handling
// lives with each feature (project switch + `?` in __root.tsx, agent actions in
// AgentDetail.tsx) since that's where the relevant state and callbacks are.

// We bind Ctrl as the action modifier on every platform - including macOS. The
// obvious Mac choice would be ⌘, but ⌘M (minimize), ⌘U (view source) etc. are
// reserved by the browser/OS and can't be reliably intercepted, so Ctrl is the
// one combination that's free everywhere and behaves the same on every machine.
export const modLabel = 'Ctrl'

// True when the action modifier (Ctrl) is held on its own - used so a binding
// like Ctrl+M fires the same way on macOS as on Linux/Windows.
export function hasMod(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey
}

// Whether a keystroke is being typed into an editable surface - a form field, a
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

// The catalogue rendered by the help overlay. Display tokens only - handling
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
      // Agent navigation uses Alt+arrows, not Ctrl+letters: Ctrl+K is Kill, and
      // arrows read naturally as "move through the list" without colliding with
      // the Ctrl action bindings or browser/OS Ctrl+letter reservations.
      { keys: ['Alt', '↑'], label: 'Previous agent' },
      { keys: ['Alt', '↓'], label: 'Next agent' },
      { keys: [modLabel, 'M'], label: 'Merge agent' },
      { keys: [modLabel, 'U'], label: 'Mark as unread' },
      { keys: [modLabel, ','], label: 'Toggle diff sidebar' },
      { keys: ['F2'], label: 'Rename agent' },
      { keys: ['B'], label: 'Copy branch name' },
      { keys: [modLabel, 'K'], label: 'Kill agent' },
    ],
  },
]

// Compact display strings for the lowlit hints shown next to menu items.
export const SHORTCUT_MERGE = `${modLabel}+M`
export const SHORTCUT_MARK_UNREAD = `${modLabel}+U`
export const SHORTCUT_KILL = `${modLabel}+K`
export const SHORTCUT_RENAME = 'F2'
export const SHORTCUT_DIFF_SIDEBAR = `${modLabel}+,`
