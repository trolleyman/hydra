import { Minus, Plus } from 'lucide-react'
import { useFontChoice, useFontSizePx, useFontSizeStep } from '../../lib/fontPrefs'
import {
  FONT_ROLES,
  FONT_ROLE_SPEC,
  maxFontStep,
  MIN_FONT_STEP,
  fontOptionsFor,
  fontSizePx,
  type FontRole,
  type FontSizeRole,
} from '../../lib/fonts'
import { Tooltip } from '../Tooltip'
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
//
// Three of the four rows also carry a size stepper. The sizes are per-role for
// the same reason the families are: wanting a denser diff is not wanting smaller
// chat prose. Interface has no stepper - see the note in lib/fonts.ts - so its
// slot renders empty rather than shifting that row's sample out of line.

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

const stepBtnClass =
  'flex h-6 w-6 items-center justify-center rounded-md text-gray-500 dark:text-gray-400 cursor-pointer ' +
  'hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 ' +
  'disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent transition-colors'

// The size control: a stepper rather than a select, because the useful move is
// "one notch bigger" and you want to see the result rather than pick a number
// out of a list. It shows the px the surface lands on, not the step - the step
// is the storage detail, and for Chat the px it shows already includes the extra
// pixel a serif family carries (see fontSizePx).
function SizeStepper({ role, fontId }: { role: FontSizeRole; fontId: string }) {
  const [step, setStep] = useFontSizeStep(role)
  const px = fontSizePx(role, step, fontId)
  const btn = (delta: -1 | 1, label: string, Icon: typeof Minus) => (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={delta < 0 ? step <= MIN_FONT_STEP : step >= maxFontStep(role)}
        onClick={() => setStep(step + delta)}
        className={stepBtnClass}
      >
        <Icon className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  )
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-1 py-0.5">
      {btn(-1, `Smaller ${FONT_ROLE_SPEC[role].label.toLowerCase()} text`, Minus)}
      {/* tabular-nums so the row doesn't shift as the number changes width, and
          a fixed box so 9 px and 17 px sit in the same place. */}
      <span className="w-11 text-center text-xs tabular-nums text-gray-600 dark:text-gray-300">{px} px</span>
      {btn(1, `Larger ${FONT_ROLE_SPEC[role].label.toLowerCase()} text`, Plus)}
    </div>
  )
}

function FontRow({ role }: { role: FontRole }) {
  const spec = FONT_ROLE_SPEC[role]
  const [font, setFont] = useFontChoice(role)
  const options = fontOptionsFor(role)
  // The store validates on read, but a category could be narrowed by a later
  // build while a stale id sits in localStorage - fall back rather than render a
  // <select> whose value matches none of its options (React warns, and the box
  // renders blank).
  const selected = options.find((o) => o.id === font) ?? options.find((o) => o.id === spec.defaultId)!
  const samplePx = useFontSizePx(role)
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
      {/* A fixed slot, so every row's sample starts at the same x whatever width
          its stepper's number happens to be. */}
      <div className="flex w-[6.75rem] shrink-0 items-center">
        <SizeStepper role={role} fontId={selected.id} />
      </div>
      {/* Inline style, not a class: this has to render the OPTION's own stack
          and size, which is a different thing from the applied --app-font-*
          variables (and the terminal role has no CSS surface at all - xterm
          takes a string). Sizing the sample is the point of the stepper being
          on this row: you see the size you are choosing, in the font you are
          choosing, before you leave Settings.

          Narrow (a phone, or the settings pane in a small window) it takes the
          line UNDER the controls - the slot the note has on a wide screen - and
          the note gives way. Beside the stepper there is only room for a few
          truncated words of it, and a sample you can't read is the one part of
          this row that has no purpose; the note is a sentence you read once. */}
      <span
        className="w-full min-w-0 truncate pl-[5.25rem] text-gray-500 dark:text-gray-400 sm:w-auto sm:flex-1 sm:pl-0"
        style={{ fontFamily: selected.stack, fontSize: `${samplePx}px` }}
      >
        {SAMPLE[role]}
      </span>
      {/* Second line: what the chosen font is good for. Sits under the select,
          past the label gutter, and is the one part of the row that changes as
          you scrub through the list. Hidden narrow, where the sample has it. */}
      <span className="hidden w-full pl-[5.25rem] text-xs text-gray-400 dark:text-gray-500 sm:block">{selected.note}</span>
    </div>
  )
}

export function FontSection() {
  return (
    <SettingSection
      title="Fonts"
      description="Typefaces for the interface, chat prose, code blocks and diffs, and the terminal panes. Each also takes a size, which moves that surface's text a pixel at a time - the whole shell for Interface, chat prose and its headings for Chat, the diff and repository views for Code, the grid for Terminal. Interface moves type only, so rows and spacing stay put; for bigger everything, use your browser's zoom. Saved in this browser only. Changing the terminal font or size re-measures its grid, so a running agent sees a resize."
    >
      <div className="flex flex-col gap-3">
        {FONT_ROLES.map((role) => (
          <FontRow key={role} role={role} />
        ))}
      </div>
    </SettingSection>
  )
}
