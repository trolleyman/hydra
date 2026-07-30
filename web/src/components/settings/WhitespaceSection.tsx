import { useWhitespaceStore } from '../../lib/whitespacePrefs'
import { WHITESPACE_MARK_LABEL, WHITESPACE_MARK_MODES } from '../../lib/whitespaceMarks'
import { SettingSection } from './shared'

// Whitespace marks - a client-only, global preference (localStorage, like
// Theme). Off by default; the two on settings differ only in how much they
// mark, so this is a segmented control rather than a switch plus a mode.
export function WhitespaceSection() {
  const marks = useWhitespaceStore((s) => s.marks)
  const setMarks = useWhitespaceStore((s) => s.setMarks)
  return (
    <SettingSection
      title="Whitespace"
      description="Draw a faint dot on each space and an arrow across each tab in code - the diff viewer, the repository browser and the chat's file cards - so an indent made of spaces reads differently from one made of tabs. The marks are drawn around the character, not instead of it, so copied code is unchanged."
    >
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
        {WHITESPACE_MARK_MODES.map((m) => {
          const active = marks === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMarks(m)}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {WHITESPACE_MARK_LABEL[m]}
            </button>
          )
        })}
      </div>
    </SettingSection>
  )
}
