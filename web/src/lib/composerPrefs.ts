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

// Whether the composers auto-pair as you type - a typed opener brings its closer
// with it, a third backtick opens a fenced block, and a mark typed over a
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
