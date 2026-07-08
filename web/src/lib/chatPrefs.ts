// Chat-mode client preferences (font + default window height), shared between
// the chat pane / agent terminal and the Settings Browser tab that offers the
// controls. Each is a zustand store - like the theme store - so both stay in
// sync: the control writes the store, the readers react. Client-only
// (localStorage), global.
//
// Font default is serif (the Claude-app look): agent prose reads as a serif
// document, while the user's own messages and all code stay sans/mono. Turning
// it off makes agent prose sans-serif too.

import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// Reads the persisted preference. Absent (or anything but 'sans') = serif, the
// default. Exported for unit testing / non-React callers.
export function loadChatSerif(): boolean {
  return readLocal(StorageKeys.chatSerif) !== 'sans'
}

// Default height (pixels) a chat window opens at when the user hasn't dragged it
// to a saved size. Deliberately taller than the terminal default (450px, see
// AgentTerminal) so a fresh chat shows more of the conversation - a chat pane
// wraps prose top-to-bottom, where a terminal reads fine in fewer rows.
export const DEFAULT_CHAT_HEIGHT = 600
// Guardrails for the user-chosen default. The floor matches the panel's own
// 150px drag minimum; the ceiling keeps a fat-fingered value from filling the
// viewport.
export const MIN_CHAT_HEIGHT = 150
export const MAX_CHAT_HEIGHT = 1400

// The user-chosen default chat height (pixels), or null when unset (use the
// built-in fallback). Read at module load so non-React callers see the latest
// value without subscribing.
export function loadChatDefaultHeight(): number | null {
  const raw = readLocal(StorageKeys.chatDefaultHeight)
  if (raw === null) return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, n))
}

interface ChatHeightState {
  height: number | null
  setHeight: (height: number | null) => void
}

// A tiny store so the settings control and any future reader stay in sync. Like
// the terminal default-rows store, singleFieldStorage keeps the stored value as
// the bare pixels string under the existing key, so loadChatDefaultHeight can
// read it directly at mount time, outside the store.
export const useChatHeightStore = create<ChatHeightState>()(
  persist(
    (set) => ({
      height: loadChatDefaultHeight(),
      setHeight: (height) => set({ height }),
    }),
    {
      name: StorageKeys.chatDefaultHeight,
      storage: singleFieldStorage('height', loadChatDefaultHeight, (height) =>
        writeLocal(StorageKeys.chatDefaultHeight, height === null ? null : String(height)),
      ),
      partialize: (s) => ({ height: s.height }),
    },
  ),
)

// Convenience hook for the settings control: current value + setter.
export function useChatDefaultHeight(): [number | null, (height: number | null) => void] {
  const height = useChatHeightStore((s) => s.height)
  const setHeight = useChatHeightStore((s) => s.setHeight)
  // Re-sync once on mount in case another tab changed the value while unmounted.
  useEffect(() => {
    useChatHeightStore.setState({ height: loadChatDefaultHeight() })
  }, [])
  return [height, setHeight]
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
