# New Agent Page Layout - Plan

## Goal

Move the agent page from one tall vertically-stacked scroll column into a
**two-pane split**: a left working pane (terminal/chat + collapsed prompt) and a
new right "inspector" pane that houses the diff, tests, previews and artifacts
behind a selector. The left sidebar and the merge/header controls stay where
they are.

## Current layout (what we have today)

Everything on the agent page is a single vertically-stacked scroll container
(`[data-main-scroll]` in `AgentDetail.tsx`):

```
+----------------------------------------------------------+
| RootLayout (flex row)                                     |
| +----------+  +------------------------------------------+|
| | LEFT     |  | AgentDetail (flex col)                   ||
| | SIDEBAR  |  | +--------------------------------------+ ||
| | (global) |  | | AgentTopBar  [Create MR][Merge][...] | ||  <- header, non-scroll
| |          |  | +--------------------------------------+ ||
| | project  |  | | [data-main-scroll] (one scroll col)  | ||
| | spawn    |  | |   metadata SeparatedRow              | ||
| | agents   |  | |   PromptBlock (read-only)            | ||
| | list     |  | |   AgentTerminal (live)              | ||
| |          |  | |   DiffViewer:                        | ||
| |          |  | |     TestsPanel (collapsible card)   | ||
| |          |  | |     PreviewPanel                    | ||
| |          |  | |     ArtifactsPanel                  | ||
| |          |  | |     Changes bar + file list + diff  | ||
| | settings |  | +--------------------------------------+ ||
| +----------+  +------------------------------------------+|
+----------------------------------------------------------+
```

Key facts that constrain the redesign:

- **Left sidebar** is app-global (`web/src/routes/__root.tsx`, `RootLayout`) -
  project dropdown, spawn form, agent list, settings. Resizable at `lg+`,
  off-canvas overlay below. Not touched by this plan.
- **Merge/MR controls** live in `AgentTopBar`
  (`web/src/components/AgentTopBar.tsx`): Create/View MR, the Merge split-button,
  the merge-when-green pill, rename/kill. Stays in the header.
- **Tests / previews / artifacts are NOT tabbed today** - they are stacked
  `CollapsibleCard`s rendered sequentially inside `DiffViewer`
  (`web/src/DiffViewer.tsx`): `TestsPanel` -> `PreviewPanel` ->
  `ArtifactsPanel` -> Changes bar + file-list column + file diffs.
- **Prompt** is `PromptBlock` (read-only, in `AgentDetail.tsx`), rendered above
  the terminal. There is no live prompt *input* on this page - prompting is done
  through the terminal/chat.
- **No split-pane library.** All resizing is hand-rolled pointer-drag
  (`handleSidebarResizeStart` in `__root.tsx`, `startResizing` for the diff
  file-list, terminal vertical drag in `AgentTerminal.tsx`). Sticky headers
  coordinate via CSS vars `--sticky-changes-h` / `--sticky-section-h` and the
  `FILE_STICKY_TOP` constant.

## Proposed layout

Split the region inside the `Outlet` (currently `AgentDetail`'s single scroll
column) into two independently-scrolling panes with a draggable divider:

```
+----------------------------------------------------------------------+
| LEFT     |  AgentTopBar   [Create MR] [Merge v] [...]                 |  <- header stays full-width
| SIDEBAR  +---------------------------+--+------------------------------+
| (global) |  LEFT PANE (working)      |::|  RIGHT PANE (inspector)      |
|          |                           |::| +--------------------------+ |
|          |  metadata SeparatedRow    |::| | [ Diff | Tests | Preview]| |  <- selector
|          |                           |::| +--------------------------+ |
|          |  > Prompt (collapsed)     |::| | Files | diff content     | |
|          |                           |::| |  ...  |  ...              | |
|          |  AgentTerminal / Chat     |::| |       |                  | |
|          |  (fills remaining height) |::| |       |                  | |
|          |                           |::| |       |                  | |
+----------+---------------------------+--+------------------------------+
                                       ^^ draggable vertical divider
```

### Left pane - "working" pane

- Metadata `SeparatedRow` (badges: type, status, verdict chip, branch, base
  selector, terminal/chat toggle, MR chip, created-ago) stays at the top.
- **Prompt collapsed by default.** Wrap `PromptBlock` in a
  `CollapsibleCard` (or a lightweight disclosure) titled with a one-line
  truncated preview of the prompt, expandable on click. Persist the
  open/closed state per agent (reuse the `agentViewPrefs` pattern). This
  reclaims vertical space for the terminal.
- `AgentTerminal` / `AgentChat` fills the remaining height of the left pane
  and scrolls internally (it already manages its own height via the drag
  handle; here it should default to "fill available" instead of a fixed px
  height).

### Right pane - "inspector" pane

- A **segmented selector** at the top: `Diff | Tests | Previews` (and possibly
  `Artifacts` - see open question). Only the selected view renders (or stays
  mounted but hidden to preserve scroll/state). This replaces the current
  stacked-collapsible-cards approach *inside* the pane.
- **Diff view** is the default. It contains the existing file-list column
  (`renderSidebar` / file tree) on its left plus the file diffs on its right,
  exactly as `DiffViewer` renders them today. The "Changes" toolbar
  (base->head selectors, stats, settings cog, refresh) sits at the top of the
  Diff view.
- **Tests view** = `TestsPanel` promoted to a first-class view (no longer a
  card buried below the diff).
- **Previews view** = `PreviewPanel`.
- **Artifacts**: leaning toward folding artifacts *into* the Diff view the way
  the repository view already does (`RepositoryArtifactsView.tsx`) - rendered
  images/videos appear alongside the file changes rather than as a separate
  tab. Keep a separate Artifacts tab only if inline placement proves cramped.

### Header - unchanged in role

`AgentTopBar` stays a full-width, non-scrolling header above both panes, keeping
the merge/MR controls, rename, kill, and the show-sidebar toggle. No change to
its contents; it simply spans both new panes.

## Selector state

- Selected inspector view (`diff | tests | previews`) persisted per agent
  (extend `agentViewPrefs`). Default `diff`.
- Show a count/badge on each selector segment when relevant: e.g. the test
  verdict chip's `N` on Tests, a "running"/"failing" dot on Previews. The
  verdict chip already exists (`TestVerdictChip`) - reuse it inline in the
  segment.
- If a project configures no tests / no previews, hide those segments (the
  panels already render `null` in that case - move that guard up to the
  selector).

## Split / resize behavior

- New draggable vertical divider between the two panes. No split-pane library
  today; either add a small one (`react-resizable-panels` is the lightest fit)
  or hand-roll a pointer-drag mirroring `handleSidebarResizeStart` in
  `__root.tsx`. Recommendation: hand-roll to match existing patterns and avoid
  a new dependency, unless we want nested/persisted splits elsewhere later.
- Persist the split ratio (per project or global) in `localStorage` via a new
  `StorageKeys` entry, like `sidebarWidth`.
- Each pane scrolls independently. This removes the single `[data-main-scroll]`
  container - the sticky-header CSS-var coordination
  (`--sticky-changes-h`, `FILE_STICKY_TOP`) must be re-scoped to the right
  pane's own scroll container instead of the page-level one.

## Responsive behavior

- **Wide (`lg`+ / `xl`+):** the two-pane split as drawn above.
- **Narrow (below the split breakpoint):** collapse back to a single column
  and turn the inspector selector into full-width tabs stacked under the
  terminal - i.e. degrade gracefully to something close to today's stacked
  layout. The diff file-list column is already `hidden md:flex`, so it keeps
  its current mobile behavior.
- Consider letting the user collapse either pane entirely (e.g. a chevron on
  the divider) for a terminal-only or diff-only focus mode.

## Open questions / decisions to make

1. **Artifacts: inline-in-diff vs its own tab?** Current lean: inline (repo
   view style). Needs a look at how busy the diff gets with artifacts injected.
2. **Split library vs hand-rolled?** Lean hand-rolled to match existing
   resize code and avoid a dependency.
3. **Which pane owns the metadata row?** Proposed: left pane. Alternative:
   a thin strip under the header spanning both.
4. **Keep panels mounted-but-hidden or unmount on tab switch?** Mounted-but-
   hidden preserves diff scroll position and avoids refetch, at some memory
   cost. Lean mounted-but-hidden for diff, lazy for previews (live servers).
5. **Default split ratio** - e.g. 40% terminal / 60% inspector? Diff usually
   wants more room.

## Affected files (first pass)

- `web/src/components/AgentDetail.tsx` - restructure the scroll region into the
  two-pane split; collapse `PromptBlock`; make the terminal fill height.
- `web/src/DiffViewer.tsx` - factor the tests/previews/artifacts cards out of
  the stacked layout; make Diff a standalone view; re-scope sticky CSS vars to
  the right pane.
- New: an inspector-pane container component owning the selector + view
  switching (e.g. `web/src/components/InspectorPane.tsx`).
- New: a split-pane primitive (or hand-rolled divider) + `StorageKeys` entry.
- `web/src/components/TestsPanel.tsx`, `PreviewPanel.tsx`, `ArtifactsPanel.tsx`
  - adapt from `CollapsibleCard` framing to first-class views.
- `web/src/components/AgentTopBar.tsx` - unchanged in content; verify it spans
  the full width above both panes.
- Add screenshot pages for the new layout in
  `web/scripts/screenshots/take-screenshots.ts` once built.

## Non-goals

- No change to the global left sidebar, spawn flow, or merge/MR logic.
- No change to the terminal/chat backend or WS wiring.
- No change to how tests/previews/artifacts data is fetched - only where it is
  rendered.
