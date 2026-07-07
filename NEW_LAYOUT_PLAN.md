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

The top of the pane has **two rows of chrome**:

```
+--------------------------------------------------+
| [ target-ref v ]   [ Diff ][ Tests ][ Previews ] |  <- row 1: GLOBAL target + view selector
+--------------------------------------------------+
| compare-vs: base v   +123 -45  [reset][refresh][*]|  <- row 2: Diff-only toolbar (base side)
+--------------------------------------------------+
| Files | diff + inline artifacts ...              |
```

- **Row 1 - global target selector + view selector.**
  - The **target selector** (the right/head side of the comparison,
    `RightSelector` today) is **global to the whole pane**: Diff, Tests,
    Previews and Artifacts all show data for the selected target commit/ref.
    It stays put and keeps its value across tab switches.
  - The **view selector** (`Diff | Tests | Previews`) picks which view renders.
    Only the selected view is mounted; switching tabs unmounts the previous one
    (matching how `CollapsibleCard` unmounts a collapsed body today - see
    decision #4). This replaces the current stacked-collapsible-cards approach
    *inside* the pane.
- **Row 2 - the selected view's own toolbar.** Contextual. For **Diff** it is
  the rest of the "Changes" toolbar: the **base selector** (the left/
  compare-against side, `LeftSelector`), +/- stats, reset,
  uncommitted/merge-conflict/behind-base buttons, refresh, settings cog. For
  **Tests** it is filter/search + group-by. For **Previews** it is whatever the
  preview controls need. Empty otherwise.

- **Only the base (compare-against) side is Diff-specific.** The two-sided
  views (Diff, and Artifacts folded into it) need a second ref to diff against;
  the target side is shared with the single-target views (Tests, Previews).
  Tests/Previews therefore show row 1's target selector but no base selector.
- **Diff view** is the default. It contains the existing file-list column
  (`renderSidebar` / file tree) on its left plus the file diffs on its right,
  exactly as `DiffViewer` renders them today.
- **Tests view** = `TestsPanel` promoted to a first-class view (no longer a
  card buried below the diff).
- **Previews view** = `PreviewPanel`, upgraded to an embedded browser (see
  "Preview pane: embedded browser" below).

### Framing

This whole redesign is essentially: **take everything currently stacked below
the terminal (prompt block, tests, previews, artifacts, diff) and move it into a
right-hand panel**, leaving the terminal/chat in the left pane. That framing
keeps the scope honest - most components move rather than change.

### The inspector pane is itself a hideable sidebar

The right pane can be collapsed and re-shown, exactly like the global left
sidebar (copy the `useSidebarStore` pattern in `web/src/lib/sidebar.ts`; persist
via a new `StorageKeys` entry). A toggle in `AgentTopBar` (mirroring the
show-sidebar button) hides it so the terminal/chat gets full width. Symmetrically
the left pane can collapse for a "diff focus" view. So the divider has three
states: **split / terminal-only / inspector-only**. On narrow screens the
default is one pane at a time with the tab bar as the switcher.

### Artifacts - inline in the Diff view (decided)

Artifacts fold **into the Diff view** (repository-view style,
`RepositoryArtifactsView.tsx`) rather than getting their own tab. Artifacts are
generated by running the project's artifact commands against **both sides** of
the comparison and surfacing what differs, so they depend on the target (row 1,
shared) *and* the base (row 2, Diff-only) - i.e. the exact same base->target
range as the diff. A separate Artifacts tab would have to duplicate both the
global target and the diff's base selector and keep them in sync. Keeping
artifacts under the diff's comparison chrome avoids that and matches how the
repository view already presents them - rendered images/videos appear alongside
the file changes. (A filter within the diff view can focus on just the artifact
entries if the combined list gets busy.)

### Preview pane: embedded browser

Today `PreviewPanel` lists each `type = "server"` entry with Open/Restart/Stop +
a build log, and **Open just `window.open`s the proxy URL in a new tab** - no
embedding. Upgrade the Previews view into a mini-browser embedded in the pane:

- **Chrome:** an address/path bar + reload + back/forward + open-in-new-tab
  (keep `window.open` as the "pop out" escape hatch) + a dropdown of the
  project's `type = "server"` entries. The split gives the iframe the whole
  pane's height.
- **Bonus - responsive testing:** viewport presets (phone/tablet/desktop)
  framing the iframe, reusing the device sizes the screenshot script already
  uses (`web/scripts/screenshots/take-screenshots.ts`).

**Talking to the iframe (injected bridge).** A different-port preview iframe is
cross-origin, so normally the parent can't read its URL or postMessage into it.
But Hydra **already reverse-proxies the preview** - `in.proxy =
httputil.NewSingleHostReverseProxy(...)` in `internal/preview/spawn.go`, and
`internal/preview/proxy.go` already branches on `text/html`. So add a
`ModifyResponse` hook that, for HTML responses, **injects a small bridge
`<script>` before `</head>`**. That script runs *inside* the iframe at the app's
own origin, so it can read everything and `postMessage` up to the parent Hydra
window. The proxy is the bridge. This dissolves both cross-origin problems:

- **Address bar reflects the real URL.** The injected script patches
  `history.pushState`/`replaceState` and listens to `popstate`/`hashchange`,
  posting the current URL + title up on every navigation - SPA soft-nav
  included. Back/forward too.
- **Frame-busting is defeated.** The same `ModifyResponse` strips
  `X-Frame-Options` / CSP `frame-ancestors` from the response so the app can't
  refuse embedding.

Bridge protocol, both directions:

- **iframe -> parent:** current URL + title per navigation; `load`/ready;
  **uncaught + console errors** (surface the preview app's runtime errors right
  in the pane - useful for the agent-testing loop); optional click-to-inspect.
- **parent -> iframe:** navigate to a path, reload, back/forward, set viewport
  preset, ping for state.

Implementation caveats:

- **CSP `script-src`:** if the app sends a strict CSP the injected inline script
  is blocked - inject with a nonce and add it to the CSP, or rewrite/strip CSP
  in the same hook. Deliberate, preview-only loosening.
- **Compression:** to splice the body the proxy must handle gzip/br - send
  `Accept-Encoding: identity` upstream or decompress in `ModifyResponse`.
- **HTML-only:** injection touches top-level HTML docs; assets/JSON are
  untouched (nothing to embed). SPA nav is covered by the history patch.
- **Trust/handshake:** share a per-preview nonce between the injected script and
  the parent; verify `event.origin`/`event.source` so other frames can't spoof.
- **Opt-in:** this modifies the user's app responses; gate it behind a
  preview-only flag even though it is already a Hydra-proxied dev server.

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

- New draggable vertical divider between the two panes, **hand-rolled** as a
  pointer-drag mirroring `handleSidebarResizeStart` in `__root.tsx` (decided -
  no split-pane library, no new dependency).
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

## Risks and gotchas

1. **Side-by-side diff width (the big one).** Today the diff owns the full
   width minus the sidebar; splitting halves it, and side-by-side mode is two
   code columns *plus* the resizable file-list column. In a ~55% pane that gets
   cramped. Mitigations: auto-fall-back to unified below a width threshold,
   make the file-list column collapse to an overlay, and lean on the
   inspector-only / diff-focus collapse to reclaim full width on demand.
2. **Terminal column count - softened by chat mode.** A raw PTY terminal
   reflows tighter when the left pane narrows, and a wide terminal was
   implicitly a feature. But the terminal can run in **chat mode**
   (`AgentChat`), which reads fine in a narrow column - so this mainly affects
   raw-terminal users, and the split can even nudge toward chat mode. Not a
   blocker.
3. **Sticky-header re-scoping.** Removing the single `[data-main-scroll]`
   container breaks three things that assume it: the CSS-var docking
   (`--sticky-changes-h`, `FILE_STICKY_TOP`, `useMeasuredHeight`),
   `forwardSidebarWheelToMain` (wheel-forwards *to* `[data-main-scroll]`), and
   per-agent scroll restore in `agentViewPrefs`. All must be re-scoped to the
   right pane's own scroll container, and there are now two scroll contexts to
   persist.
4. **Vertical squeeze on laptops.** Side-by-side panes both live at full page
   height, so a tall diff scrolls inside a short pane - on a 13" screen
   vertical space becomes the constraint instead of horizontal. Collapsing the
   prompt (already planned) and a collapsible metadata row help.
5. **Divider drag over iframe/xterm.** Pointer-drag resizing across an iframe
   or the xterm canvas gets swallowed by them - add a transparent full-pane
   overlay during the drag. The preview iframe reintroduces the same need.
6. **Handle proliferation.** Four resize handles now: global sidebar, split
   divider, diff file-list, terminal height. The split divider and file-list
   handle are both near each other - visually distinguish them.

(Dropped: an earlier "two adjacent base selectors" concern - the metadata
row's base-*branch* selector already sits beside the diff's comparison
selectors today; moving that block into a right panel changes nothing.)

## Open questions / decisions to make

1. ~~**Artifacts: inline-in-diff vs its own tab?**~~ DECIDED: inline in the
   Diff view - they share the diff's base->head selector (see "Artifacts"
   above). Revisit only if the combined list proves too busy even with a
   filter.
2. ~~**Split library vs hand-rolled?**~~ DECIDED: hand-rolled, mirroring
   `handleSidebarResizeStart` in `__root.tsx`. No new dependency.
3. **Which pane owns the metadata row?** Proposed: left pane. Alternative:
   a thin strip under the header spanning both.
4. ~~**Keep panels mounted-but-hidden or unmount on tab switch?**~~ DECIDED:
   unmount inactive views - match what happens today. `CollapsibleCard`
   already unmounts a collapsed body ("the body stays mounted only while open";
   a collapsed card never renders its heavy children), and diff files
   lazy mount/unmount by viewport. So only the active tab's view is mounted,
   and the diff keeps its existing per-file lazy mounting inside. Tradeoff:
   diff scroll/selected-file resets on return and data refetches - same as
   reopening a collapsed card today; persist scroll via `agentViewPrefs` if it
   feels bad. Caveat: unmounting the **Previews** iframe on switch tears down
   the embedded app (full reload + server wake on return); if that is annoying
   in practice, special-case previews to stay alive. Start with uniform
   unmount.
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
- `web/src/components/AgentTopBar.tsx` - add the inspector-pane hide/show
  toggle (mirror the show-sidebar button); content otherwise unchanged; verify
  it spans the full width above both panes.
- `web/src/lib/sidebar.ts` (pattern to copy) + new store/`StorageKeys` entries
  for inspector-pane collapse state and split ratio.
- Add screenshot pages for the new layout in
  `web/scripts/screenshots/take-screenshots.ts` once built.

Preview embedded browser (Go + web):
- `internal/preview/spawn.go` / `internal/preview/proxy.go` - add a
  `ModifyResponse` hook to the reverse proxy: inject the bridge `<script>` into
  HTML, strip `X-Frame-Options` / CSP `frame-ancestors`, handle CSP nonce +
  `Accept-Encoding: identity` for injection.
- New: the injected bridge script (served/embedded) + a parent-side
  `postMessage` client in the Previews view.

## Non-goals

- No change to the global left sidebar, spawn flow, or merge/MR logic.
- No change to the terminal/chat backend or WS wiring.
- No change to how tests/previews/artifacts data is fetched - only where it is
  rendered.
