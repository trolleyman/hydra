import { useState } from 'react'
import { useChatDefaultHeight, DEFAULT_CHAT_HEIGHT, MIN_CHAT_HEIGHT, MAX_CHAT_HEIGHT } from '../../lib/chatPrefs'
import { SettingSection } from './shared'

// Chat height - a client-only user preference (localStorage, global; not project-
// scoped, so it reads/writes the same value on either settings page, like Theme)
// for the pixel height a chat window opens at. Kept separate from the terminal
// default (which is in rows) so chat windows and terminal windows can start at
// different sizes. Once the user drags a window to a size that saved height wins;
// this only seeds the first open. Empty input = built-in default.
export function ChatHeightSection() {
  const [height, setHeight] = useChatDefaultHeight()
  // Local draft so the field can hold an in-progress value (e.g. typing "6" on
  // the way to "600") without the min-clamp snapping it up on every keystroke.
  // We only normalise - clamp to [MIN, MAX] - when the field loses focus.
  const [draft, setDraft] = useState<string>(height == null ? '' : String(height))
  // Re-sync when the stored value changes from elsewhere (another tab/page).
  // Done during render (height only changes on commit or an external write, never
  // mid-keystroke - the input owns `draft` while focused), so no extra paint.
  const [prevHeight, setPrevHeight] = useState(height)
  if (prevHeight !== height) { setPrevHeight(height); setDraft(height == null ? '' : String(height)) }
  const commit = () => {
    if (draft.trim() === '') { setHeight(null); return }
    const n = parseInt(draft, 10)
    if (!Number.isFinite(n)) { setDraft(height == null ? '' : String(height)); return }
    const clamped = Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, n))
    setHeight(clamped)
    setDraft(String(clamped))
  }
  return (
    <SettingSection
      title="Chat height"
      description={`Height (pixels) a chat window opens at before you drag it to a size. Terminal windows use their own height setting. Default ${DEFAULT_CHAT_HEIGHT}.`}
    >
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={MIN_CHAT_HEIGHT}
          max={MAX_CHAT_HEIGHT}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder={String(DEFAULT_CHAT_HEIGHT)}
          aria-label="Default chat window height in pixels"
          className="w-28 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500">px</span>
      </div>
    </SettingSection>
  )
}
