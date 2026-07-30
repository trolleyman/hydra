# Fonts and type sizes

Read this **before** adding a `text-*` class, changing a font size, or wondering
why `text-xs` is 13px here when Tailwind says 12.

Two independent axes, and they are deliberately not the same mechanism:

- **Family** - four roles, four CSS variables, one picker.
- **Size** - four steps, four CSS variables, one stepper each. A step is an
  offset in whole pixels, never an absolute size.

Both live in `web/src/lib/fonts.ts` (the catalogue and the numbers),
`web/src/lib/fontPrefs.ts` (the stores + the effect that writes the variables to
`<html>`), and `web/src/components/settings/FontSection.tsx` (the four rows in
Settings -> Browser -> Fonts). All of it is client-only and per-browser
(localStorage), like Theme.

## The four roles

| Role | Covers | Family var | Size base | Default |
| --- | --- | --- | --- | --- |
| `ui` | the whole app shell - sidebar, buttons, panels, settings, labels | `--app-font-ui` (= Tailwind's `--font-sans`) | 13px, the `text-xs` rung | Inter |
| `chat` | chat-mode agent + user prose | `--app-font-chat` | 13px sans / 14px serif | Merriweather |
| `code` | every `font-mono` surface: diffs, the repository view, code blocks, gutters | `--app-font-code` (= Tailwind's `--font-mono`) | 12px | Fira Code |
| `terminal` | the xterm panes | `--app-font-terminal` | 13px | Fira Code |

`ui` and `code` are wired to Tailwind's own `font-sans` / `font-mono` in the
`@theme` block of `index.css`, so every existing utility picks the choice up with
no per-component wiring. `chat` and `terminal` are read explicitly (the chat
pane's `.chat-font`, xterm's `fontFamily` option).

Each role also publishes `<var>-features` for `font-feature-settings`, because
OpenType tags are not portable between families - Iosevka's `cv10` is a dotted
zero and another family's `cv10` is something else entirely. Only the font that
asked for a tag gets it.

## Sizes are steps, not values

Every size control stores a **signed whole number of pixels** ('-1', '2'), not a
size, and publishes it as a length on `--app-font-<role>-step`. Range is
`MIN_FONT_STEP` (-2) to `MAX_FONT_STEP` (+4), except Interface - see below.
Absent / 0 is the default, and at 0 every `calc()` lands exactly where it did
before the control existed.

The shape is deliberate:

- Each surface keeps its own metrics. A diff row is 12px, chat prose 13/14px,
  the terminal 13px; +1 moves all of them by one pixel rather than flattening
  them onto one number.
- It stays whole-pixel. The chat pane's line boxes are whole pixels so that the
  last line of a streaming turn does not jiggle (the long note in `index.css`),
  which a ratio would undo.

Consumers:

- **ui** - the type ladder below.
- **chat** - `.chat-leading` / `.chat-leading-xs` / `.chat-serif` in `index.css`,
  plus the chat pane's own base size in `AgentChat.tsx`.
- **code** - `CODE_TEXT` / `CODE_LEADING` in `web/src/lib/diffMetrics.ts`, shared
  by the diff renderers, their measurement replica, and the repository view.
- **terminal** - no CSS surface at all: xterm takes a number, read through
  `useFontSizePx('terminal')`.

## The interface type ladder

The shell's sizes are one named ladder, defined once in `index.css`:

| Class | px | Was |
| --- | --- | --- |
| `text-4xs` | 10 | `text-[9px]` |
| `text-3xs` | 11 | `text-[10px]`, `text-[10.5px]` |
| `text-2xs` | 12 | `text-[11px]`, `text-[11.5px]` |
| `text-xs` | 13 | `text-xs` (12), `text-[12px]`, `text-[12.5px]` |
| `text-sm` | 15 | `text-sm` (14), `text-[13px]` |
| `text-base` | 17 | `text-base` (16), `text-[16px]` |
| `text-lg` / `text-xl` / `text-2xl` / `text-3xl` | 19 / 21 / 25 / 31 | 18 / 20 / 24 / 30 |

Every rung is `calc(<px> + var(--app-font-ui-step, 0px))`.

Two things happened at once there and they are separable: the ladder went up one
pixel, and it became steppable.

The lift was overdue. The shell was built on 10/11/12/14, and **275 of its 305
hardcoded sizes were 10 or 11px** (153 at 11, 120 at 10, two more at the halves)
- work to read on a laptop, and worse on a phone, which renders at byte-identical
sizes because there is no responsive type scale at all. Adding one would have
papered over a scale that was a step too small on both.

**`text-xs` and up are `@theme` entries; `text-2xs`/`3xs`/`4xs` are `@utility`
rules.** Not a style choice: a `--text-*` entry pairs a *line-height* with the
size, and the arbitrary `text-[10px]` classes those three replaced set font-size
alone. Introducing a line-height where there wasn't one would reflow most of the
sidebar. The `@theme` rungs keep Tailwind's own ratio line-heights, which scale
with the size for free.

### Why it is not root font-size

Root font-size scales Tailwind's rem *spacing* too - padding, gaps, widths - so
it is browser zoom with extra steps, and Ctrl +/- already does that job properly.
The step moves type and nothing else.

That is also what bounds it. Type grows inside rows whose heights are fixed in px
(`h-7`, `h-8`), sticky-header offsets and `calc(100vh-140px)` viewport math do
not follow a font-size change, so Interface caps at `UI_MAX_FONT_STEP` (+3) where
the others cap at +4. That number is measured, not guessed: sweep every step at
desktop and phone widths and check every fixed-height row for a child taller than
its box.

The sidebar footer is the worked example of what "measured" means there. The
usage strip was `shrink-0`, so it drew straight over the settings gear - at every
size, invisibly, until bigger type made it obvious. It now shrinks the uptime
label instead (and hides it outright when the Claude usage strip is present,
folding it into the restart button's tooltip). If you find something that breaks
at +3, fix the layout rather than lowering the cap; the cap is the last resort.

## What is deliberately NOT on the ladder

- **Chat prose.** Its own role, its own step, its own leading rules. The chat
  markdown renderer sizes headings in **em** - a multiple of the prose they sit
  in - because that variant renders at half a dozen body sizes (13px chat, 14px
  serif chat, 12px sub-agent cards, 10px config previews). A markdown **table**
  takes no size at all: it is body content, so it reads at the size of the prose
  around it.
- **Code surfaces.** `diffMetrics` spells its size as the rem literal rather than
  `text-xs` so a diff row follows the *Code* step. This is load-bearing now that
  `text-xs` is 13px: using it there would silently resize every diff row and
  break the row-height measurement the diff viewer depends on.
- **The terminal.** A number, not a class.
- **An avatar's monogram** (`web/src/components/Avatar.tsx`). Sized to its box,
  not to reading text: the box is `w-5`/`w-6` and the step moves type only, so a
  monogram on the ladder would grow inside a circle that cannot follow it. What
  makes it legible is the 20px disc. Same reason its icon's `w-3.5` is a literal.

That last one is the general test for a new exception: **is this text being read,
or is it part of a fixed-size mark?** If a box it cannot escape defines its size,
keep it a literal and say why in the file.

## Rules for new UI

1. **Use a rung.** `rg -o 'text-\[[0-9.]+px\]' src` should return only the
   avatar's two monogram sizes, each with its reason beside it. A literal is
   frozen: it will not follow the Interface control, and it will read a pixel
   below its neighbours for ever after.
2. **A merge conflict on a size line is mechanical.** Someone else's branch was
   written against the old literals; take *their* version of the code and map the
   literals onto their rungs from the table above.
3. **Don't add a rung.** The ladder is gapless from 10 to 17 and there is no name
   between `xs` and `sm` on purpose - Tailwind's `2xs < xs` direction mirrors
   `2xl > xl`, so a 14px rung has no honest name. If 13 is too small and 15 too
   big, one of them is right.
4. **Measure, don't squint** (see the baseline notes in CLAUDE.md). Drop a
   zero-height `inline-block` probe to find a baseline; take cap height from a
   canvas `measureText('H').actualBoundingBoxAscent`. Reading a baseline off an
   element's own box does not work once `.optical-center` is on it.
5. **Verify at the extremes**, not just at 0. `localStorage['hydra-font-size-ui']`
   takes the step, so a Playwright `addInitScript` can boot the app at -2 or +3.

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
