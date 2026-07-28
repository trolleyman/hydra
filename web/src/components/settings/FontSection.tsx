import { useFontChoice } from '../../lib/fontPrefs'
import { FONT_ROLES, FONT_ROLE_SPEC, fontOptionsFor, type FontRole } from '../../lib/fonts'
import { SettingSection } from './shared'

// Fonts - client-only, global preferences (localStorage, like Theme) for the
// four typefaces the app uses: the interface, chat-mode agent prose, code/diffs,
// and the terminal panes. Replaces the old boolean chat serif/sans toggle, which
// is now just "pick a serif or a sans for Chat".
//
// A row per role rather than one control: they are genuinely independent
// choices. Each row carries a live sample, because a font name tells you nothing
// - and for the two mono roles the sample is the string a code font is actually
// judged on (l1I, 0O, the ligature pairs).

const SAMPLE: Record<FontRole, string> = {
  ui: 'Spawn a head on this branch',
  chat: 'I read the diff, and the test passes now.',
  code: 'const l1I = 0O; if (a !== b) => x',
  terminal: '$ git log --oneline | head -3',
}

const selectClass =
  'w-52 shrink-0 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white ' +
  'dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 cursor-pointer ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all'

function FontRow({ role }: { role: FontRole }) {
  const spec = FONT_ROLE_SPEC[role]
  const [font, setFont] = useFontChoice(role)
  const options = fontOptionsFor(role)
  // The store validates on read, but a category could be narrowed by a later
  // build while a stale id sits in localStorage - fall back rather than render a
  // <select> whose value matches none of its options (React warns, and the box
  // renders blank).
  const selected = options.find((o) => o.id === font) ?? options.find((o) => o.id === spec.defaultId)!
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label className="w-[4.5rem] shrink-0 text-sm text-gray-600 dark:text-gray-300" htmlFor={`font-${role}`}>
        {spec.label}
      </label>
      <select
        id={`font-${role}`}
        value={selected.id}
        onChange={(e) => setFont(e.target.value)}
        className={selectClass}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {/* Inline style, not a class: this has to render the OPTION's own stack,
          which is a different thing from the applied --app-font-* variable (and
          the terminal role has no CSS surface at all - xterm takes a string). */}
      <span
        className="min-w-0 flex-1 truncate text-[13px] text-gray-500 dark:text-gray-400"
        style={{ fontFamily: selected.stack }}
      >
        {SAMPLE[role]}
      </span>
      {/* Second line: what the chosen font is good for. Sits under the select,
          past the label gutter, and is the one part of the row that changes as
          you scrub through the list. */}
      <span className="w-full pl-[5.25rem] text-xs text-gray-400 dark:text-gray-500">{selected.note}</span>
    </div>
  )
}

export function FontSection() {
  return (
    <SettingSection
      title="Fonts"
      description="Typefaces for the interface, chat prose, code blocks and diffs, and the terminal panes. Saved in this browser only. Changing the terminal font re-measures its grid, so a running agent sees a resize."
    >
      <div className="flex flex-col gap-3">
        {FONT_ROLES.map((role) => (
          <FontRow key={role} role={role} />
        ))}
      </div>
    </SettingSection>
  )
}
