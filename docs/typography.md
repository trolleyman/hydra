# Fonts and type sizes

Read this **before** adding a `text-*` class or changing a font size.

Two independent axes, deliberately not the same mechanism:

- **Family** - four roles, four CSS variables, one picker.
- **Size** - four steps, four CSS variables, one stepper each. A step is an
  offset in whole pixels, never an absolute size.

Both live in `web/src/lib/fonts.ts` (the catalogue and the numbers),
`web/src/lib/fontPrefs.ts` (the stores + the effect that writes the variables to
`<html>`), and `web/src/components/settings/FontSection.tsx` (the four rows in
Settings -> Browser -> Fonts). All client-only and per-browser (localStorage),
like Theme.

## The four roles

| Role | Covers | Family var | Size at step 0 | Default |
| --- | --- | --- | --- | --- |
| `ui` | the whole app shell - sidebar, buttons, panels, settings, labels | `--app-font-ui` (= Tailwind's `--font-sans`) | the ladder below | Inter |
| `chat` | chat-mode agent + user prose | `--app-font-chat` | 13px sans / 14px serif | Merriweather |
| `code` | every `font-mono` surface: diffs, the repository view, code blocks, gutters | `--app-font-code` (= Tailwind's `--font-mono`) | 12px | Fira Code |
| `terminal` | the xterm panes | `--app-font-terminal` | 13px | Fira Code |

`ui` and `code` are wired to Tailwind's `font-sans` / `font-mono` in the `@theme`
block of `index.css`, so every existing utility picks the choice up with no
per-component wiring. `chat` and `terminal` are read explicitly (the chat pane's
`.chat-font`, xterm's `fontFamily` option).

Each role also publishes `<var>-features` for `font-feature-settings`. Keep it
per-role: OpenType tags are not portable between families - Iosevka's `cv10` is a
dotted zero and another family's `cv10` is something else entirely.

The single `Iosevka` option is built from Iosevka Term Nerd Font Mono. The Term
metrics keep arrows and other wide symbols inside one terminal cell; the patched
face embeds Powerline and Nerd Font marks at their intended size. Do not restore
a separate plain-Iosevka option: its grid-unsafe symbols are the only meaningful
difference, while using a size-adjusted fallback for its Nerd glyphs makes marks
such as Starship's branch icon visibly too small.

Every other bundled monospace also uses its Nerd Font Mono build, under the
ordinary family name shown in Settings. This keeps prompt icons at the patched
font's intended visual size. `System mono` is the sole exception: its actual
typeface belongs to the host OS, so Hydra cannot bundle a matching patched face
and retains the size-adjusted Symbols Nerd Font fallback for it.

## Sizes are steps

Each control stores a **signed whole number of pixels** ('-1', '2') and
publishes it as a length on `--app-font-<role>-step`. `MIN_FONT_STEP` (-2) to
`MAX_FONT_STEP` (+4), except Interface, which stops at `UI_MAX_FONT_STEP` (+3).
Absent / 0 is the default.

Consume it as `calc(<the surface's own px> + var(--app-font-<role>-step, 0px))`,
never as a resolved size. That way each surface keeps its own metrics - a diff
row is 12px, chat prose 13/14px, the terminal 13px - and a step moves all of them
by a pixel instead of flattening them onto one number. Keep it whole-pixel: the
chat pane's line boxes are whole pixels so the last line of a streaming turn does
not jiggle (the long note in `index.css`), which a ratio would undo.

Where each step is consumed:

- **ui** - the ladder below.
- **chat** - `.chat-leading` / `.chat-leading-xs` / `.chat-serif` in `index.css`,
  plus the chat pane's own base size in `AgentChat.tsx`.
- **code** - `CODE_TEXT` / `CODE_LEADING` in `web/src/lib/diffMetrics.ts`, shared
  by the diff renderers, their measurement replica, and the repository view.
- **terminal** - no CSS surface at all: xterm takes a number, read through
  `useFontSizePx('terminal')`.

## The interface type ladder

Every size in the shell is one of these, defined once in `index.css`:

| Class | px |
| --- | --- |
| `text-4xs` | 10 |
| `text-3xs` | 11 |
| `text-2xs` | 12 |
| `text-xs` | 13 |
| `text-sm` | 15 |
| `text-base` | 17 |
| `text-lg` / `text-xl` / `text-2xl` / `text-3xl` | 19 / 21 / 25 / 31 |

Note `text-xs` is 13px here and `text-sm` 15px - Tailwind's own 12/14 are
overridden. Every rung is `calc(<px> + var(--app-font-ui-step, 0px))`, so the
Interface control moves the whole shell at once.

`text-xs` and up are `@theme` entries; `text-2xs` / `text-3xs` / `text-4xs` are
`@utility` rules. That split matters if you ever add a rung: a `--text-*` entry
pairs a *line-height* with the size, so a new small rung declared that way would
introduce leading where the elements using it have none, and reflow every row
that carries it. The `@theme` rungs keep Tailwind's ratio line-heights, which
scale with the size for free.

## What not to do

- **Don't write `text-[13px]`.** `rg -o 'text-\[[0-9.]+px\]' src` should return
  only the avatar's two monogram sizes, each with its reason beside it. A literal
  is frozen: it will not follow the Interface control, and it will read a pixel
  below its neighbours for ever after.
- **Don't add a rung.** The ladder is gapless from 10 to 17, and there is no name
  between `xs` and `sm` on purpose: Tailwind's `2xs < xs` mirrors `2xl > xl`, so
  a 14px rung has no honest name. If 13 is too small and 15 too big, one of them
  is right.
- **Don't use `text-xs` on a code surface.** A diff row must follow the *Code*
  step, so `diffMetrics` spells its size as the rem literal instead. Using the
  ladder there would resize every diff row and break the row-height measurement
  the diff viewer depends on.
- **Don't reach for root font-size** to scale the UI. It scales Tailwind's rem
  *spacing* too - padding, gaps, widths - which is browser zoom with extra steps,
  and Ctrl +/- already does that job. The Interface step moves type only.
- **Don't raise `UI_MAX_FONT_STEP` without measuring.** Type grows inside rows
  whose heights are fixed in px (`h-7`, `h-8`), and sticky-header offsets and
  `calc(100vh-140px)` viewport math do not follow a font-size change. If
  something breaks at +3, fix that layout rather than lowering the cap.

## Text that is not on the ladder

- **Chat prose.** Its own role, step and leading rules. The chat markdown
  renderer sizes headings in **em** - a multiple of the prose they sit in -
  because that variant renders at half a dozen body sizes (13px chat, 14px serif
  chat, 12px sub-agent cards, 10px config previews). A markdown **table** takes
  no size at all: it is body content, so it reads at the size of the prose around
  it.
- **Code surfaces and the terminal**, per the two rules above.
- **An avatar's monogram** (`web/src/components/Avatar.tsx`). Sized to its box,
  not to reading text: the box is `w-5`/`w-6` and the step moves type only, so a
  monogram on the ladder would grow inside a circle that cannot follow it. What
  makes it legible is the 20px disc. Same reason its icon's `w-3.5` is a literal.

That last one is the test for a new exception: **is this text being read, or is
it part of a fixed-size mark?** If a box it cannot escape defines its size, keep
it a literal and say why in the file.

## Checking your work

- **Merging a branch written before the ladder?** Take *their* version of the
  code, then map the literals: 9 -> `text-4xs`, 10 / 10.5 -> `text-3xs`,
  11 / 11.5 -> `text-2xs`, 12 / 12.5 / 13 -> `text-xs`, 16 -> `text-base`.
- **Measure, don't squint** (see the baseline notes in CLAUDE.md). Drop a
  zero-height `inline-block` probe to find a baseline; take cap height from a
  canvas `measureText('H').actualBoundingBoxAscent`. Reading a baseline off an
  element's own box does not work once `.optical-center` is on it.
- **Check the extremes, not just step 0.** `localStorage['hydra-font-size-ui']`
  holds the step, so a Playwright `addInitScript` can boot the app at -2 or +3.
  Look for text taller than a fixed-height row, and for a row that overflows
  rather than shrinking.

## Where things live

| | |
| --- | --- |
| Catalogue, roles, base sizes, clamps | `web/src/lib/fonts.ts` |
| Stores, persistence, the `<html>` variables | `web/src/lib/fontPrefs.ts` |
| The ladder, `@theme` + `@utility`, chat leading | `web/src/index.css` |
| The four Settings rows + stepper | `web/src/components/settings/FontSection.tsx` |
| localStorage keys | `web/src/lib/storage.ts` (`font*`, `fontSize*`) |
| Code surfaces' shared size/leading | `web/src/lib/diffMetrics.ts` |
| Self-hosted + subset webfonts | `web/scripts/build-fonts.ts`, `web/public/fonts` |

The font build is content-addressed and shared across Hydra heads and sandboxed
runners through the project-scoped `FONT_BUILD_CACHE_DIR` cache. A signature is
cut once; later worktrees copy its generated faces into `web/public/fonts`
instead of running the subsetter again. Outside Hydra, the same script falls
back to the conventional `~/.cache/hydra/fonts` directory.
