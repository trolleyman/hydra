// Chat-mode font preference, shared between the chat pane (which renders agent
// messages) and the Settings Browser tab (which offers the toggle). Kept in one
// zustand store - like the theme store - so both stay in sync: the control
// writes the store, the chat pane reacts.
//
// Default is serif (the Claude-app look): agent prose reads as a serif document,
// while the user's own messages and all code stay sans/mono. Turning it off
// makes agent prose sans-serif too. Client-only (localStorage), global.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// Reads the persisted preference. Absent (or anything but 'sans') = serif, the
// default. Exported for unit testing / non-React callers.
export function loadChatSerif(): boolean {
  return readLocal(StorageKeys.chatSerif) !== 'sans'
}

interface ChatFontState {
  serif: boolean
  setSerif: (serif: boolean) => void
}

// singleFieldStorage keeps the stored value as the bare 'sans' marker (only
// written when serif is turned off) rather than persist's JSON envelope, so the
// key stays human-readable and loadChatSerif can read it directly.
export const useChatFontStore = create<ChatFontState>()(
  persist(
    (set) => ({
      serif: loadChatSerif(),
      setSerif: (serif) => set({ serif }),
    }),
    {
      name: StorageKeys.chatSerif,
      storage: singleFieldStorage('serif', loadChatSerif, (serif) =>
        writeLocal(StorageKeys.chatSerif, serif ? null : 'sans'),
      ),
      partialize: (s) => ({ serif: s.serif }),
    },
  ),
)
