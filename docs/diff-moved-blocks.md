# Design: moved-block visualization ("boxes", done properly)

Status: **design, unbuilt.** A first attempt (git `--color-moved=zebra`-style
per-line violet/sky tint) was built and reverted - a whole-block colour wash read
as heavy and confusing, and an in-place re-indent registering as a "move" was
noise (see [diff-viewer-improvements.md](diff-viewer-improvements.md) item 7). This
captures how to do it *properly* - boxes + labels + navigation rather than a line
tint - grounded in a survey of shipping tools and this viewer's constraints.

## What shipping tools actually do

The reference implementation is **SemanticDiff** (VS Code extension + GitHub app);
the rest of the field is thinner than you'd expect.

- **SemanticDiff:** draws a **border (box) around both halves** - source and
  destination. The **border colour is a per-move identity key** (which box pairs
  with which), *not* add/remove polarity. In its side-by-side layout a connector
  line is drawn across the centre divider between the two halves; **when the
  halves are far apart the connector degrades to a short dotted stub**, and a
  **minimap** shows matching-coloured blocks as the whole-file overview. Hovering
  a box reveals a **jump arrow** (top-right) that scrolls to the counterpart -
  click-to-jump, not a live peek. A pure move is labelled *"Moved without
  changes"* (italic); a move that was also edited gets a **"Compare With
  Original"** button that lazily swaps in the original and shows the intra-move
  add/remove. Moved code is **de-emphasized** (framed, not painted red/green) so
  new logic stands out.
- **JetBrains / Araxis / Meld / Beyond Compare:** center-gutter "linking lines"
  between two panes, but **only for adjacent aligned changes** - none of them
  detect or connect *moves*. (IntelliJ's only "movement" feature is in git
  blame, not the diff.)
- **git `--color-moved` / delta:** the line-tint approach we're leaving behind.
  Worth stealing two instincts: **alternating colours** to separate adjacent
  blocks, and **`dimmed-zebra`'s de-emphasis** (moved code is less important than
  new logic).
- **GitHub / GitLab:** neither ships this; both have long-standing open requests,
  and users install SemanticDiff to route around the gap. difftastic explicitly
  has **no** move support.
- **Literal long-distance connectors** (arrows/curves across many screens or
  files) appear only in *research* tools (e.g. "Code Flows"), never in production.

### The load-bearing conclusions

1. **Nobody draws a literal connector across a long distance or across files.**
   The proven pattern is: **connector only when both halves are close and
   on-screen; otherwise colour-key + label + click-to-jump, with a minimap for
   the global overview.**
2. **Centre-gutter connectors are a side-by-side device.** They need two columns
   and a divider to draw into. In a unified/inline layout the only thing that
   works is border + colour + label + jump.
3. **De-emphasize moved code**, don't emphasize it - a quiet neutral frame, not
   loud red/green.
4. **Colour = per-move identity**, so overlapping/adjacent moves stay
   distinguishable; push global structure to a minimap, not the main gutter.
5. **Pure move vs move-with-edits** is a **label/badge state on the box**, with
   the intra-move diff loaded **on demand** so the common (boring) pure-move case
   stays quiet.

## What this viewer's architecture forces

This is not SemanticDiff's world; the constraints change the design materially
(see [web-agent-page.md](web-agent-page.md) for the render pipeline):

- **Default layout is unified / a vertical stack of file cards**, not a fixed
  two-pane split. There is no persistent centre divider to draw a connector into.
  A side-by-side mode exists (`sideBySide`) but is opt-in. => **The centre-gutter
  connector is out for the default view.** At most it's a side-by-side-only
  enhancement.
- **Both halves of a move are usually not co-visible.** They can be many screens
  apart, in **different file cards**, or in a card whose body is **lazily
  unmounted** (`FileDiff`'s `near` latch) or inside a **collapsed gap**. You often
  cannot see both ends at once, so a literal connector would have nothing to
  connect. => matches the survey: **do not attempt literal cross-card lines.**
- **Rows are measured/virtual-ish.** A file body's height is driven by a
  ResizeObserver wrapper and lazy placeholders; an absolutely-positioned SVG
  overlay box would have to be recomputed on every scroll/reflow and fights that
  model. => **draw the box with CSS borders on the run of rows** (the block's
  first row gets a top border, last row a bottom border, all rows left/right
  borders) rather than an overlay. It reflows for free with the rows.
- **Word-diff, per-file "viewed", and the reverted move detector already
  establish the "compute a per-line map, thread it into the hunks" pattern** -
  the box treatment slots into the same seam (`UnifiedHunk`/`SideBySideHunk`
  already take per-line maps).

## Proposed design

A move is a pair of blocks: a **source** (deleted here) and a **destination**
(added there), possibly in different files. Render each block as a **quiet boxed
region** with an identity colour and a navigation label; never a red/green wash;
never a literal long line.

### Detection (reuse, with one fix)

Reuse the reverted `detectMoves` algorithm (in git history: intern changed lines
by content, greedy constant-indent-delta block growth, `COLOR_MOVED_MIN_ALNUM`
= 20 threshold, cross-file). **Fix the false positive that sank v1:** an *in-place
re-indent* (a block deleted then re-added immediately below, only re-indented) is
not a meaningful "move." Gate it out - e.g. require the source and destination to
be **non-adjacent** (separated by more than a few lines, or in different files),
or drop matches whose two halves are the same lines shifted only by a constant
indent within one hunk. Those re-indents then render as ordinary diffs with the
existing indent word-highlight (which is what a reviewer wants).

### Rendering (each half)

- **Boxed region:** CSS border around the run of rows (identity colour, low
  saturation). No red/green row tint on a *pure* move - it's not new logic.
- **Identity colour:** assigned per move, cycling a small palette; adjacent moves
  get different colours (SemanticDiff's border-colour / zebra's alternation).
- **Label on the box:** `↑ Moved from src/foo.ts:120` (destination) /
  `↓ Moved to src/bar.ts:88` (source), muted, one line - the same restrained
  affordance as the funcname hunk labels already in the viewer.
- **Jump:** clicking the label (or a corner arrow revealed on hover) scrolls to
  the counterpart, reusing `scrollToDiffLine` in `diffScroll.ts` (it already
  handles a counterpart in a lazily-mounted / collapsed / different card, gliding
  the card in and centring the line). This is the workhorse - it makes "far
  apart / cross-file" a non-problem without any connector.
- **Badge state:** `Moved` (quiet) vs `Moved + edited`. For an edited move, keep
  the box quiet by default and gate the intra-move add/remove diff behind an
  explicit toggle ("Show changes"), matching SemanticDiff's "Compare With
  Original".

### Optional, later

- **Hover-peek** (unclaimed by any shipping tool): hovering a box shows a small
  floating preview of the counterpart's first few lines, so you can confirm a
  move without navigating. Nice differentiator; prototype after the MVP.
- **Side-by-side connector:** only in `sideBySide` mode and only when both halves
  are on-screen, draw a stub in the centre gutter; degrade to a dotted stub +
  colour when off-screen. Do not build for the unified view.
- **Minimap / overview:** the viewer has no minimap today; if one is ever added,
  echo move colours there as the global "far apart" fallback.

## Tiered build plan

1. **MVP:** detection (reused + in-place-re-indent fix) -> quiet boxed regions
   with identity colour + "Moved from/to path:line" label + click-to-jump (reuse
   `scrollToDiffLine`). A settings toggle, default **off** (v1's default-on was
   part of the complaint). This alone delivers the core value - "this isn't new
   code, and here's its other half" - with no connector.
2. **Edited moves:** `Moved + edited` badge + on-demand intra-move diff.
3. **Hover-peek** of the counterpart.
4. **Side-by-side-only** centre connector + (if it ever exists) minimap echo.

## What to skip

- **Literal connectors across cards / long distances** - no shipping tool does
  it; infeasible with lazy/virtual bodies and cross-file halves.
- **An SVG overlay box** - fights the measured/virtual row model; use CSS borders
  on rows.
- **Default-on, loud colouring** - the reverted v1's mistake; keep it quiet,
  de-emphasized, and opt-in.

## Sources

Prior-art survey (SemanticDiff moved-code docs + PR-viewer blog; delta
`--color-moved`; IntelliJ/Araxis/Meld linking lines; GitHub/GitLab open requests;
difftastic's lack of move support; "Code Flows" research connectors) captured in
the research that produced this doc. Key reference:
<https://semanticdiff.com/docs/understand-diff/moved-code/> and
<https://semanticdiff.com/blog/pr-viewer/>.
