// One list of every preference the Settings -> Browser tab owns, so that "Reset
// to defaults" and the tab itself cannot drift apart.
//
// Each entry names a store, how to read its current value, what its default is,
// and how to put it back. Resetting goes through the STORES rather than clearing
// localStorage keys: the stores hold the live value in memory and write through
// on set, so a key deleted underneath them would leave the UI showing the old
// setting until a reload.
//
// Adding a client preference? Add it here in the same commit. The count the
// button shows is derived from this list, so a pref missing from it silently
// survives a reset - which is worse than not having the button.
import { useThemeStore } from './theme'
import { fontStores, fontSizeStores } from './fontPrefs'
import { FONT_ROLES, FONT_ROLE_SPEC } from './fonts'
import { usePasteMarkersStore, useAutoPairStore } from './composerPrefs'
import {
  useChatStreamStore,
  useChatStepsStore,
  useChatCodeLinesStore,
  useChatBashIndentStore,
  useChatHeightStore,
} from './chatPrefs'
import { DEFAULT_BASH_INDENT } from './bashFormat'
import { useWhitespaceStore } from './whitespacePrefs'
import { useDefaultRowsStore } from './terminalGeometry'
import { useNotifyStore } from './notifyPrefs'
import { useSyncExternalStore } from 'react'

// Every store the list above reads, so a subscriber can be told about any of
// them without knowing which pref changed. Zustand's subscribe returns its own
// unsubscribe, so this stays a one-liner per store.
const PREF_STORES = [
  useThemeStore,
  ...Object.values(fontStores),
  ...Object.values(fontSizeStores),
  usePasteMarkersStore,
  useAutoPairStore,
  useChatStreamStore,
  useChatStepsStore,
  useChatCodeLinesStore,
  useChatBashIndentStore,
  useChatHeightStore,
  useWhitespaceStore,
  useDefaultRowsStore,
  useNotifyStore,
]

// Which control a pref belongs to. The Fonts section has its own reset - eight
// knobs in one section is enough to want to undo on its own, without touching
// your theme - so its prefs are tagged, and every scope is a filter over the one
// list rather than a second list that could disagree with it.
export type PrefGroup = 'fonts'

interface Pref {
  // What it is, for the confirm dialog's summary. Lower case: it is read in a
  // sentence ("Reset the chat font, the interface size and 2 others?").
  label: string
  group?: PrefGroup
  isDefault: () => boolean
  reset: () => void
}

// A boolean/scalar pref: one getter, one setter, one default value.
function simple<T>(label: string, get: () => T, set: (v: T) => void, fallback: T, group?: PrefGroup): Pref {
  return { label, group, isDefault: () => get() === fallback, reset: () => set(fallback) }
}

export function browserPrefs(): Pref[] {
  const theme = useThemeStore.getState()
  const paste = usePasteMarkersStore.getState()
  const pair = useAutoPairStore.getState()
  const stream = useChatStreamStore.getState()
  const steps = useChatStepsStore.getState()
  const lines = useChatCodeLinesStore.getState()
  const indent = useChatBashIndentStore.getState()
  const height = useChatHeightStore.getState()
  const ws = useWhitespaceStore.getState()
  const rows = useDefaultRowsStore.getState()
  const notify = useNotifyStore.getState()
  return [
    simple('theme', () => theme.mode, theme.setMode, 'system'),
    // Family and size are separate controls per role, so they are separate
    // entries - resetting a size you nudged should not be reported as also
    // resetting a font you never touched.
    ...FONT_ROLES.map((role): Pref => {
      const store = fontStores[role].getState()
      const fallback = FONT_ROLE_SPEC[role].defaultId
      return simple(
        `the ${FONT_ROLE_SPEC[role].label.toLowerCase()} font`,
        () => store.font,
        store.setFont,
        fallback,
        'fonts',
      )
    }),
    ...FONT_ROLES.map((role): Pref => {
      const store = fontSizeStores[role].getState()
      return simple(`the ${FONT_ROLE_SPEC[role].label.toLowerCase()} size`, () => store.step, store.setStep, 0, 'fonts')
    }),
    simple('paste markers', () => paste.enabled, paste.setEnabled, true),
    simple('auto-close pairs', () => pair.enabled, pair.setEnabled, true),
    simple('smooth streaming', () => stream.smooth, stream.setSmooth, true),
    simple('step folding', () => steps.grouped, steps.setGrouped, true),
    simple('code line numbers', () => lines.lineNumbers, lines.setLineNumbers, true),
    simple('shell indent', () => indent.indent, indent.setIndent, DEFAULT_BASH_INDENT),
    simple('chat height', () => height.height, height.setHeight, null),
    simple('whitespace marks', () => ws.marks, ws.setMarks, 'off'),
    simple('terminal height', () => rows.rows, rows.setRows, null),
    // Off is the default, and turning it off never prompts - only turning it ON
    // needs the OS permission, so a reset can't get stuck behind a dialog.
    simple('desktop notifications', () => notify.enabled, () => void notify.setEnabled(false), false),
  ]
}

// The prefs currently sitting on something other than their default. Pass a
// group to ask about one section instead of the whole tab.
export function changedBrowserPrefs(group?: PrefGroup): Pref[] {
  return browserPrefs().filter((p) => (group ? p.group === group : true) && !p.isDefault())
}

export function resetBrowserPrefs(group?: PrefGroup): void {
  for (const p of changedBrowserPrefs(group)) p.reset()
}

function subscribeBrowserPrefs(onChange: () => void): () => void {
  const offs = PREF_STORES.map((store) => store.subscribe(onChange))
  return () => offs.forEach((off) => off())
}

// A COUNT, not the list: useSyncExternalStore compares snapshots by identity and
// would loop for ever on a fresh array. Callers that want the list call
// changedBrowserPrefs() when they need it, which is on click.
export function useChangedBrowserPrefCount(group?: PrefGroup): number {
  return useSyncExternalStore(
    subscribeBrowserPrefs,
    () => changedBrowserPrefs(group).length,
    () => 0,
  )
}

// "the chat font, the interface size and 2 others" - the confirm dialog says
// what is about to move rather than making you guess at "defaults".
export function describeChanged(prefs: Pref[], max = 3): string {
  const names = prefs.map((p) => p.label)
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? ''
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  const rest = names.length - max
  return `${names.slice(0, max).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`
}
