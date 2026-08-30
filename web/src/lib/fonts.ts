// The font catalogue: which typefaces Hydra offers, where each one is allowed to
// be used, and the CSS variable that carries the choice.
//
// Four independent roles, because the jobs are genuinely different:
//
//   ui        the app shell - sidebar, buttons, settings, labels
//   chat      chat-mode agent prose (a document you read, not a UI you operate)
//   code      code blocks, diffs, the repository view - anything `font-mono`
//   terminal  the xterm panes
//
// Each role writes a CSS variable on <html> (see fontPrefs.ts). index.css maps
// Tailwind's --font-sans / --font-mono onto the ui / code variables, so the
// existing `font-sans` and `font-mono` utilities pick the choice up with no
// per-component wiring; chat and terminal are read explicitly by the chat pane
// and by xterm's fontFamily option.
//
// Where the fonts come from:
//   - The system stacks resolve to whatever the OS provides and cost nothing.
//   - Iosevka is the terminal-safe Iosevka Term Nerd Font Mono build, self-hosted
//     from public/fonts. scripts/build-fonts.ts fetches and subsets it at BUILD
//     time - the .woff2 files are gitignored, not committed. A checkout that has
//     never run that script falls through to the shared Nerd Symbols face and
//     system monospace.
//   - Everything else comes from the single Google Fonts stylesheet in
//     index.html. A @font-face is only fetched when a glyph actually needs it,
//     so listing nine families costs one ~3KB stylesheet, not nine downloads.
// Adding a family means touching BOTH this file and the source that serves it.

export type FontCategory = 'sans' | 'serif' | 'mono'
export type FontRole = 'ui' | 'chat' | 'code' | 'terminal'

// The fallbacks every stack ends with - Tailwind v4's own defaults, so a stack
// that fails to load lands exactly where the app used to render. index.css
// repeats these once as the pre-JS fallback of each --app-font-* variable.
export const SYSTEM_SANS =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'"
export const SYSTEM_SERIF = "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif"
// Tailwind's mono default plus an explicit emoji tail, which its sans stack has
// and its mono stack does not. A terminal is where emoji actually turn up (agent
// output, commit messages), and none of the monospace families draws them - so
// without this the fallback is whatever the browser picks last, which on Linux is
// often nothing. scripts/build-fonts.ts does the other half of this: it cuts the
// default-emoji codepoints OUT of Iosevka so the emoji font gets the chance.
export const SYSTEM_MONO =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace, " +
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'"

// Iosevka's OpenType features, matched to the ones this machine's dotfiles turn
// on everywhere else (fontconfig 50-iosevka-features.conf, VS Code, Zed), so a
// diff reads the same in Hydra as it does in the editor it came from:
//
//   calt 1   the standard ligature set (=> -> != ... ), on by default anyway,
//            listed so the intent is explicit rather than inherited
//   VLAC 2   equality ligations (== ===) drawn without the notch in the middle
//   VSAB 3   the arrow/slash ligation variant
//   cv10 6   zero with a centre dot instead of a slash
//
// The tag numbers are Iosevka's own (doc/character-variants.md). CSS syntax
// differs from fontconfig's: comma-separated pairs, each tag quoted.
const IOSEVKA_FEATURES = "'calt' 1, 'VLAC' 2, 'VSAB' 3, 'cv10' 6"

// 'Hydra Arrows' is a unicode-range-scoped arrows face (see the long note in
// index.css): webfont latin subsets ship no arrows, so every ← → an agent writes
// in serif prose fell through to a hairline OS substitute. It goes FIRST but is
// only ever consulted for U+2190-21FF, so letters still come from the real
// family. Serif stacks only - that is where the problem was measured, and a
// proportional arrow inside a monospace grid would break the column alignment
// the mono fonts exist to keep.
const ARROWS = "'Hydra Arrows'"

const sansStack = (family?: string) => (family ? `'${family}', ${SYSTEM_SANS}` : SYSTEM_SANS)
const serifStack = (family?: string) =>
  family ? `${ARROWS}, '${family}', ${SYSTEM_SERIF}` : `${ARROWS}, ${SYSTEM_SERIF}`

// Every mono stack carries the Nerd Fonts symbol face (see the @font-face pair
// in index.css). It is unicode-range-scoped to the private-use blocks, so it is
// only ever consulted for a Powerline separator or a Devicon and every letter
// still comes from the real family - but without it those code points are tofu
// boxes in any font, because no normal monospace draws them.
//
// `cellEm` is the family's advance width as a fraction of the em, MEASURED at
// 1000px rather than assumed: 0.5 for both Iosevka cuts, 0.6 for everything else
// including the system stack. It picks which of the two size-adjusted faces to
// use, so a symbol comes out exactly one cell wide instead of the em-wide glyph
// upstream ships - which would push the rest of the line and break a TUI's
// column alignment. Both faces are the same file, so this costs one download.
const monoStack = (family: string | undefined, cellEm: 50 | 60) =>
  [family && `'${family}'`, `'Hydra Nerd Symbols ${cellEm}'`, SYSTEM_MONO].filter(Boolean).join(', ')

export interface FontOption {
  id: string
  label: string
  category: FontCategory
  // The full CSS font-family value this option resolves to.
  stack: string
  // One line under the name in the picker. Say what the font is FOR, not what it
  // looks like - the sample beside it already shows that.
  note: string
  // font-feature-settings to apply wherever this font is used, or undefined for
  // the font's own defaults. Only set where a family has features worth turning
  // on that are off by default - a tag the rendered font doesn't have is ignored,
  // but the settings are published per-role rather than globally so that Fira
  // Code's cv10 (a different glyph entirely) can't be switched on by Iosevka's.
  features?: string
}

export const FONT_OPTIONS: FontOption[] = [
  // ── Sans ──
  { id: 'system-sans', label: 'System sans', category: 'sans', stack: sansStack(), note: "This device's own UI font" },
  { id: 'inter', label: 'Inter', category: 'sans', stack: sansStack('Inter'), note: 'Neutral, tuned for screens' },
  { id: 'roboto-flex', label: 'Roboto Flex', category: 'sans', stack: sansStack('Roboto Flex'), note: 'Matches the prompt box' },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', category: 'sans', stack: sansStack('IBM Plex Sans'), note: 'A little more character' },

  // ── Serif ──
  { id: 'system-serif', label: 'System serif', category: 'serif', stack: serifStack(), note: "This device's own serif" },
  { id: 'merriweather', label: 'Merriweather', category: 'serif', stack: serifStack('Merriweather'), note: 'Sturdy at small sizes' },
  { id: 'source-serif', label: 'Source Serif 4', category: 'serif', stack: serifStack('Source Serif 4'), note: 'Lighter, more bookish' },

  // ── Mono ──
  { id: 'system-mono', label: 'System mono', category: 'mono', stack: monoStack(undefined, 60), note: "This device's own monospace" },
  {
    id: 'iosevka',
    label: 'Iosevka',
    category: 'mono',
    stack: monoStack('Iosevka', 50),
    // The patched Term Mono face keeps wide symbols and Nerd Font icons inside
    // one narrow terminal cell. The label stays simply "Iosevka": there is no
    // longer a second, grid-unsafe cut to distinguish it from.
    note: 'Narrow, terminal-safe Nerd Font',
    features: IOSEVKA_FEATURES,
  },
  { id: 'fira-code', label: 'Fira Code', category: 'mono', stack: monoStack('Fira Code', 60), note: 'Ligatures for => and !=' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', category: 'mono', stack: monoStack('JetBrains Mono', 60), note: 'Tall x-height, roomy' },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', category: 'mono', stack: monoStack('IBM Plex Mono', 60), note: 'Warmer, slightly wider' },
  { id: 'source-code-pro', label: 'Source Code Pro', category: 'mono', stack: monoStack('Source Code Pro', 60), note: 'Plain and unfussy' },
]

export const FONT_BY_ID: Map<string, FontOption> = new Map(FONT_OPTIONS.map((f) => [f.id, f]))

export interface FontRoleSpec {
  label: string
  // The CSS custom property this role's stack is written to on <html>. Its
  // font-feature-settings ride `${cssVar}-features` alongside it.
  cssVar: string
  // Which categories may be picked for this role, in the order they are listed.
  categories: FontCategory[]
  defaultId: string
}

export const FONT_ROLES: FontRole[] = ['ui', 'chat', 'code', 'terminal']

export const FONT_ROLE_SPEC: Record<FontRole, FontRoleSpec> = {
  // The app shell. Nothing sets a family on <body>, so this is just Tailwind's
  // --font-sans, which every unstyled element inherits through preflight.
  ui: {
    label: 'Interface',
    cssVar: '--app-font-ui',
    categories: ['sans', 'serif'],
    // Inter rather than the system stack, so the shell looks the same on every
    // OS instead of inheriting whatever the machine's UI font happens to be
    // (Cantarell, Segoe UI, SF). System sans is still one click away.
    defaultId: 'inter',
  },
  // Chat-mode prose, agent and user alike. Code inside it keeps its mono class,
  // so it follows the Code font instead.
  chat: {
    label: 'Chat',
    cssVar: '--app-font-chat',
    // Serif first, because serif is the default and the interesting choice here
    // is which serif - the sans options are the old toggle's "off".
    categories: ['serif', 'sans'],
    defaultId: 'merriweather',
  },
  // Every `font-mono` surface: chat code blocks, the diff viewer, the repository
  // view, the line-number gutters.
  code: {
    label: 'Code',
    cssVar: '--app-font-code',
    categories: ['mono'],
    // Fira Code, matching the terminal - one monospace across the app unless the
    // user says otherwise. It also comes off the Google Fonts stylesheet, where
    // Iosevka is self-hosted from public/fonts and only exists once
    // scripts/build-fonts.ts has run, so this is the choice that renders as
    // intended in a fresh checkout too.
    defaultId: 'fira-code',
  },
  terminal: {
    label: 'Terminal',
    cssVar: '--app-font-terminal',
    categories: ['mono'],
    // NOT Iosevka, and the reason is emoji - it is why the terminal picked Fira
    // Code first, back when code defaulted to Iosevka. xterm gives an emoji two
    // cells; the browser draws it from the colour emoji font at ~1.2em
    // regardless of the mono font in use. Measured
    // at the 13px terminal size: Iosevka's cell is 7px, so an emoji covers 114%
    // of its two cells and clips the glyph beside it, where Fira Code's 8px cell
    // makes it an exact 100% fit. Iosevka is still offered, and is still
    // the better answer for a TUI's box drawing - it is just not the safer
    // default for output that contains emoji, which agent output routinely does.
    defaultId: 'fira-code',
  },
}

// ── Size ──────────────────────────────────────────────────────────────────────
//
// A size is a STEP in whole pixels from the size the surface already renders at,
// not an absolute value, and that shape is deliberate:
//
//   - Every affected surface keeps its own metrics. Chat prose is 13px sans /
//     14px serif, a diff row is 12px, the terminal is 13px - and a step of +1
//     moves all of them by one pixel rather than flattening them onto one
//     number. Chat in particular: the serif treatment reads a pixel larger than
//     the sans one on purpose (see .chat-serif in index.css), and an absolute
//     control would silently discard that the moment you switched family.
//   - It stays whole-pixel. The chat pane's line boxes are whole pixels to stop
//     the streaming last line from jiggling (the long note in index.css), which
//     a fractional or ratio-based size would undo.
//   - A step of 0 is the default, so the stored value is absent for anyone who
//     never touched it and every surface renders byte-identically to before.
//
// Interface included - but it took a named type ladder to make it possible, and
// the objection that kept it out before is still half true, so it is worth being
// precise about what changed.
//
// The old note here said the shell has no single lever to pull: fixed row
// heights (h-7/h-8), sticky-header offsets and `calc(100vh-140px)` viewport math
// do not follow a font-size change, and the only global lever - root font-size -
// scales Tailwind's rem spacing too, which is browser zoom with extra steps.
//
// The second half is why this is NOT root font-size. Every rung of the shell's
// scale (--text-4xs ... --text-3xl in index.css) carries + var(--app-font-ui-step)
// instead, so the step moves type and nothing else: no padding, no gaps, no
// widths. The first half still stands, and it is what bounds the range rather
// than the range being a taste question - text grows inside rows that don't, so
// a big enough step eventually crowds an h-7 row. UI_MAX_FONT_STEP is that
// bound, measured rather than guessed (see the sweep in the commit that added
// it): +3 keeps every fixed-height row clear.
// Every role has a size now, so this is FontRole under the name the size code
// reads better with. It stays a distinct name rather than being search-replaced
// away: a role without a size is a plausible future (a fixed-size surface), and
// the call sites already say which of the two things they mean.
export type FontSizeRole = FontRole
export const FONT_SIZE_ROLES: FontSizeRole[] = FONT_ROLES

export const MIN_FONT_STEP = -2
export const MAX_FONT_STEP = 4
// Interface stops one step short of the others - see above.
export const UI_MAX_FONT_STEP = 3

// What each role renders at with the step at 0 - the number the Settings stepper
// counts from, and the one the CSS falls back to when no variable is set. Chat's
// is the sans figure; a serif chat font adds the pixel .chat-serif already adds.
// Interface names the `text-xs` rung, which is not the largest rung but is the
// one the shell is mostly built from - 293 of its ~600 sized elements - so it is
// the number that describes what a step will feel like.
export const FONT_BASE_PX: Record<FontSizeRole, number> = { ui: 13, chat: 13, code: 12, terminal: 13 }

// The step a role may actually be set to. Interface is capped a step lower than
// the rest (UI_MAX_FONT_STEP), because its type grows inside rows whose heights
// are fixed in px.
export function maxFontStep(role?: FontSizeRole): number {
  return role === 'ui' ? UI_MAX_FONT_STEP : MAX_FONT_STEP
}

export function clampFontStep(step: number, role?: FontSizeRole): number {
  if (!Number.isFinite(step)) return 0
  return Math.min(maxFontStep(role), Math.max(MIN_FONT_STEP, Math.round(step)))
}

// The px a role's text lands on at this step. `fontId` only matters for chat,
// where a serif carries its own +1px treatment - pass the role's chosen font so
// the Settings stepper shows the size the prose will actually be.
export function fontSizePx(role: FontSizeRole, step: number, fontId?: string): number {
  const serifChat = role === 'chat' && FONT_BY_ID.get(fontId ?? '')?.category === 'serif'
  return FONT_BASE_PX[role] + (serifChat ? 1 : 0) + clampFontStep(step, role)
}

// The options a role may be set to, in category order.
export function fontOptionsFor(role: FontRole): FontOption[] {
  const { categories } = FONT_ROLE_SPEC[role]
  return categories.flatMap((c) => FONT_OPTIONS.filter((f) => f.category === c))
}

// Resolves an id to the option it names, falling back to the role's default for
// an id that is unknown or not allowed in this role (a stale localStorage value,
// or one written by an older/newer build).
export function fontFor(role: FontRole, id: string): FontOption {
  const spec = FONT_ROLE_SPEC[role]
  const font = FONT_BY_ID.get(id)
  if (font && spec.categories.includes(font.category)) return font
  return FONT_BY_ID.get(spec.defaultId)!
}

export function fontStackFor(role: FontRole, id: string): string {
  return fontFor(role, id).stack
}

// The font-feature-settings value for a choice. `normal` (rather than an empty
// string) so it can be dropped straight into a CSS variable and still mean "the
// font's own defaults" when the variable is inherited by something else.
export function fontFeaturesFor(role: FontRole, id: string): string {
  return fontFor(role, id).features ?? 'normal'
}

export function isValidFontFor(role: FontRole, id: string | null): boolean {
  if (!id) return false
  const font = FONT_BY_ID.get(id)
  return !!font && FONT_ROLE_SPEC[role].categories.includes(font.category)
}
