// Composer client preferences, shared by the spawn form and the chat composer
// (plus the Settings Browser tab that offers the controls). Client-only
// (localStorage), global - mirrors the chatPrefs stores.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// Whether pasting an attachment (an image, or a large text block that gets
// attached) also inserts its "[filename]" marker at the caret, so the prompt
// text references the attachment explicitly. Absent (or anything but '0') =
// on, the default.
export function loadPasteMarkers(): boolean {
  return readLocal(StorageKeys.pasteMarkers) !== '0'
}

interface PasteMarkersState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const usePasteMarkersStore = create<PasteMarkersState>()(
  persist(
    (set) => ({
      enabled: loadPasteMarkers(),
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: StorageKeys.pasteMarkers,
      storage: singleFieldStorage('enabled', loadPasteMarkers, (enabled) =>
        writeLocal(StorageKeys.pasteMarkers, enabled ? null : '0'),
      ),
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
)

// Which unmodified Enter behaviour the chat composer uses. By default Enter
// sends and Cmd/Ctrl+Enter sends too. Turning this off makes Enter add a newline
// and leaves Cmd/Ctrl+Enter as the explicit send shortcut. Shift+Enter is a
// newline in either mode.
export function loadEnterSends(): boolean {
  return readLocal(StorageKeys.enterSends) !== '0'
}

interface EnterSendsState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useEnterSendsStore = create<EnterSendsState>()(
  persist(
    (set) => ({
      enabled: loadEnterSends(),
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: StorageKeys.enterSends,
      storage: singleFieldStorage('enabled', loadEnterSends, (enabled) =>
        writeLocal(StorageKeys.enterSends, enabled ? null : '0'),
      ),
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
)

// Whether the composers auto-pair as you type - a typed opener brings its closer
// with it, Enter on a "```" line opens a fenced block, and a mark typed over a
// selection wraps it (lib/autoPair.ts has the full rules). Absent (or anything
// but '0') = on, the default.
export function loadAutoPair(): boolean {
  return readLocal(StorageKeys.autoPair) !== '0'
}

interface AutoPairState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useAutoPairStore = create<AutoPairState>()(
  persist(
    (set) => ({
      enabled: loadAutoPair(),
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: StorageKeys.autoPair,
      storage: singleFieldStorage('enabled', loadAutoPair, (enabled) =>
        writeLocal(StorageKeys.autoPair, enabled ? null : '0'),
      ),
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
)

// Whether the BROWSER's own spellchecker runs in Hydra's text boxes - every
// HighlightedTextarea (the chat composer, the spawn prompt, review comments, a
// commit message, an agent pre-prompt) plus the question card's free-text
// answers. Absent/anything but '1' = off, the default.
//
// Off by default because a prompt is not prose: it is mostly filenames, branch
// names, identifiers and pasted code - `[image1.png]`, `oapi-codegen`,
// `internal/heads` - and every one of those draws a red squiggle. The app's code
// surfaces (the shell editor, the config editors) already opted out one by one;
// this makes that the default everywhere and gives the two or three people who
// want spelling help on a long prose prompt one switch to get it back.
//
// It is all-or-nothing on purpose: `spellcheck` is a per-element attribute, so a
// <textarea> cannot exempt a range of its own text, and WHICH words the browser
// marks (and when) is a browser internal - Chrome re-checks lazily around the
// caret and drops markers elsewhere when the value is rewritten wholesale, which
// is why the same sentence can come back underlined differently twice in a row.
export function loadSpellcheck(): boolean {
  return readLocal(StorageKeys.spellcheck) === '1'
}

interface SpellcheckState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useSpellcheckStore = create<SpellcheckState>()(
  persist(
    (set) => ({
      enabled: loadSpellcheck(),
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: StorageKeys.spellcheck,
      storage: singleFieldStorage('enabled', loadSpellcheck, (enabled) =>
        writeLocal(StorageKeys.spellcheck, enabled ? '1' : null),
      ),
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
)
