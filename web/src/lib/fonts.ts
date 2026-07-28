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
//   - Iosevka and Iosevka Term are self-hosted from public/fonts. They are not on
//     Google Fonts and have no maintained CDN build, so scripts/build-fonts.ts
//     fetches and subsets them at BUILD time - the .woff2 files are gitignored,
//     not committed. A checkout that has never run that script falls through to
//     the system monospace.
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
    note: 'Narrow - fits more diff per line',
    features: IOSEVKA_FEATURES,
  },
  {
    id: 'iosevka-term',
    label: 'Iosevka Term',
    category: 'mono',
    stack: monoStack('Iosevka Term', 50),
    // The only difference from Iosevka: the wide symbols (arrows, some math) are
    // drawn one cell across instead of two, which is what keeps a TUI's columns
    // lined up. Harmless outside a terminal, so it is offered for code too.
    note: 'Iosevka with every glyph one cell wide',
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
    defaultId: 'system-sans',
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
    defaultId: 'iosevka',
  },
  terminal: {
    label: 'Terminal',
    cssVar: '--app-font-terminal',
    categories: ['mono'],
    // NOT Iosevka, despite it being the default for code, and the reason is
    // emoji. xterm gives an emoji two cells; the browser draws it from the
    // colour emoji font at ~1.2em regardless of the mono font in use. Measured
    // at the 13px terminal size: Iosevka's cell is 7px, so an emoji covers 114%
    // of its two cells and clips the glyph beside it, where Fira Code's 8px cell
    // makes it an exact 100% fit. Iosevka Term is still offered, and is still
    // the better answer for a TUI's box drawing - it is just not the safer
    // default for output that contains emoji, which agent output routinely does.
    defaultId: 'fira-code',
  },
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
