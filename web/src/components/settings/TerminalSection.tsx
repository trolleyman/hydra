import { useState } from 'react'
import { useDefaultTerminalRows, DEFAULT_SPAWN_ROWS, MIN_SPAWN_ROWS, MAX_SPAWN_ROWS } from '../../lib/terminalGeometry'
import { SettingSection } from './shared'

// Terminal - a client-only user preference (localStorage, global; not project-
// scoped, so it reads/writes the same value on either settings page, like Theme)
// for the height new heads start at. Width always follows the browser's last
// terminal width; height follows the last height too, falling back to this
// default when the browser has no terminal history yet. Empty input = built-in
// default.
export function TerminalSection() {
  const [rows, setRows] = useDefaultTerminalRows()
  // Local draft so the field can hold an in-progress value (e.g. typing "3" on
  // the way to "30") without the min-clamp snapping it up on every keystroke.
  // We only normalise - clamp to [MIN, MAX] - when the field loses focus.
  const [draft, setDraft] = useState<string>(rows == null ? '' : String(rows))
  // Re-sync when the stored value changes from elsewhere (another tab/page).
  // Done during render (rows only changes on commit or an external write, never
  // mid-keystroke - the input owns `draft` while focused), so no extra paint.
  const [prevRows, setPrevRows] = useState(rows)
  if (prevRows !== rows) { setPrevRows(rows); setDraft(rows == null ? '' : String(rows)) }
  const commit = () => {
    if (draft.trim() === '') { setRows(null); return }
    const n = parseInt(draft, 10)
    if (!Number.isFinite(n)) { setDraft(rows == null ? '' : String(rows)); return }
    const clamped = Math.min(MAX_SPAWN_ROWS, Math.max(MIN_SPAWN_ROWS, n))
    setRows(clamped)
    setDraft(String(clamped))
  }
  return (
    <SettingSection
      title="Terminal"
      description={`Height (rows) new heads start at when this browser has no last terminal height yet. Width always follows your last terminal width. Default ${DEFAULT_SPAWN_ROWS}.`}
    >
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={MIN_SPAWN_ROWS}
          max={MAX_SPAWN_ROWS}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder={String(DEFAULT_SPAWN_ROWS)}
          aria-label="Default terminal height in rows"
          className="w-28 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500">rows</span>
      </div>
    </SettingSection>
  )
}
