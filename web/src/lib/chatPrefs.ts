// Chat-mode client preferences (default window height, smooth streaming, code
// line numbers, shell indent), shared between the chat pane and the Settings
// Browser tab that offers the controls. Each is a zustand store - like the theme
// store - so both stay in sync: the control writes the store, the readers react.
// Client-only (localStorage), global.
//
// The chat FONT used to live here as a serif/sans boolean. It is now one role of
// the font selector - see lib/fonts.ts + lib/fontPrefs.ts, which also reads this
// module's old key once so an existing sans-chat browser stays sans.

import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_BASH_INDENT, MAX_BASH_INDENT } from './bashFormat'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

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

// Reads the persisted smooth-streaming preference. Absent (or anything but
// 'off') = on, the default. Exported for non-React callers / unit testing.
export function loadChatSmooth(): boolean {
  return readLocal(StorageKeys.chatSmoothStreaming) !== 'off'
}

interface ChatSmoothState {
  smooth: boolean
  setSmooth: (smooth: boolean) => void
}

// Smooth (paced) streaming toggle. Like the serif store: singleFieldStorage
// keeps the stored value as the bare 'off' marker (only written when turned off)
// so loadChatSmooth can read it directly at mount and the key stays readable.
export const useChatStreamStore = create<ChatSmoothState>()(
  persist(
    (set) => ({
      smooth: loadChatSmooth(),
      setSmooth: (smooth) => set({ smooth }),
    }),
    {
      name: StorageKeys.chatSmoothStreaming,
      storage: singleFieldStorage('smooth', loadChatSmooth, (smooth) =>
        writeLocal(StorageKeys.chatSmoothStreaming, smooth ? null : 'off'),
      ),
      partialize: (s) => ({ smooth: s.smooth }),
    },
  ),
)

// Reads the persisted code line-number preference. Absent (or anything but
// 'off') = on, the default. Exported for non-React callers / unit testing.
export function loadChatCodeLineNumbers(): boolean {
  return readLocal(StorageKeys.chatCodeLineNumbers) !== 'off'
}

interface ChatCodeLinesState {
  lineNumbers: boolean
  setLineNumbers: (lineNumbers: boolean) => void
}

// Line-number gutter on multi-line code blocks in the transcript. A long shell
// command wraps, and without numbers a wrapped continuation reads as its own
// step - the numbers are what tell the two apart. Stored as the bare 'off'
// marker, like the smooth-streaming toggle.
export const useChatCodeLinesStore = create<ChatCodeLinesState>()(
  persist(
    (set) => ({
      lineNumbers: loadChatCodeLineNumbers(),
      setLineNumbers: (lineNumbers) => set({ lineNumbers }),
    }),
    {
      name: StorageKeys.chatCodeLineNumbers,
      storage: singleFieldStorage('lineNumbers', loadChatCodeLineNumbers, (lineNumbers) =>
        writeLocal(StorageKeys.chatCodeLineNumbers, lineNumbers ? null : 'off'),
      ),
      partialize: (s) => ({ lineNumbers: s.lineNumbers }),
    },
  ),
)

// Reads the persisted bash block-indent width. Absent or unparseable = the
// built-in default. Exported for non-React callers / unit testing.
export function loadChatBashIndent(): number {
  const raw = readLocal(StorageKeys.chatBashIndent)
  if (raw === null) return DEFAULT_BASH_INDENT
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BASH_INDENT
  return Math.min(MAX_BASH_INDENT, n)
}

interface ChatBashIndentState {
  indent: number
  setIndent: (indent: number) => void
}

// How far the shell-command formatter indents the body of a for/while/if/case
// block it has split onto its own lines (0 = flush left). Stored as the bare
// number, and only when it differs from the default, so the key stays absent for
// anyone who never touched it - same shape as the other chat prefs.
export const useChatBashIndentStore = create<ChatBashIndentState>()(
  persist(
    (set) => ({
      indent: loadChatBashIndent(),
      setIndent: (indent) => set({ indent }),
    }),
    {
      name: StorageKeys.chatBashIndent,
      storage: singleFieldStorage('indent', loadChatBashIndent, (indent) =>
        writeLocal(StorageKeys.chatBashIndent, indent === DEFAULT_BASH_INDENT ? null : String(indent)),
      ),
      partialize: (s) => ({ indent: s.indent }),
    },
  ),
)
