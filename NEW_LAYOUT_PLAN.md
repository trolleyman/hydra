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
| | agents   |  | |   PromptBlock (terminal mode only)   | ||
| | list     |  | |   AgentTerminal panel (fixed-height  | ||
| |          |  | |     drag window; tab strip: agent    | ||
| |          |  | |     tab = xterm OR ChatPane + bash   | ||
| |          |  | |     tabs + "+")                      | ||
| |          |  | |   DiffViewer:                        | ||
| |          |  | |     Changes bar (selectors, cog)    | ||
| |          |  | |     TestsPanel (collapsible card)   | ||
| |          |  | |     PreviewPanel                    | ||
| |          |  | |     ArtifactsPanel                  | ||
| |          |  | |     file list + file diffs          | ||
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
  sections rendered sequentially inside `DiffViewer`
  (`web/src/DiffViewer.tsx`), *below* the Changes toolbar: Changes bar ->
  `TestsPanel` -> `PreviewPanel` -> `ArtifactsPanel` -> file-list column +
  file diffs. Tests and previews wrap in `CollapsibleCard`; `ArtifactsPanel`
  has no single outer card - it renders a filter bar plus one `CollapsibleCard`
  *per artifact set*, each set's files in a masonry grid.
- **Chat mode is a persisted per-agent mode, but today it renders as a tab of
  the terminal panel.** `agent.chat_mode` (Claude only) is toggled in the
  metadata row; switching restarts the Claude process in the new framing
  (conversation preserved via `--continue`). In `AgentTerminal.tsx` the fixed
  agent tab renders `ChatPane` (`web/src/components/AgentChat.tsx`) instead of
  an xterm; bash tabs stay real terminals alongside it, and the whole tab strip
  sits inside the same fixed-height row-snapping drag window (chat gets its own
  default height, 600px / a global pref in `web/src/lib/chatPrefs.ts`).
- **`ChatPane` brings its own chrome** and manages it internally: a top-left
  selector switching between the main conversation and per-sub-agent chats, the
  transcript (scroll position persisted via `agentViewPrefs.chatScrollTop`),
  and a bottom composer with attachments, slash commands, a drag-resizable
  min-height and a persisted draft (`chatDraft` / `chatComposerRows` in
  `agentViewPrefs`). None of that needs to change for the split - it is all
  internal to the pane.
- **Prompt** is `PromptBlock` (read-only, in `AgentDetail.tsx`), rendered above
  the terminal - but **only in terminal mode**. Chat-mode heads skip it
  entirely: the task is replayed as the first message in the chat
  (`--replay-user-messages`), so the block would be redundant. There is no live
  prompt *input* on this page - prompting is done through the terminal/chat.
- **Diff comments flow into chat.** Inline diff comments and "Fix with agent"
  are delivered to chat-mode agents as chat messages. In the split this becomes
  a cross-pane interaction: comment on a diff line in the right pane, see it
  land in the left chat.
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
|          |  > Prompt (terminal mode) |::| | Files | diff content     | |
|          |                           |::| |  ...  |  ...              | |
|          |  ChatPane (chat mode) OR  |::| |       |                  | |
|          |  AgentTerminal (terminal) |::| |       |                  | |
|          |  (fills remaining height) |::| |       |                  | |
|          |                           |::| |       |                  | |
+----------+---------------------------+--+------------------------------+
                                       ^^ draggable vertical divider
```

### Left pane - "working" pane

The left pane's content depends on the head's mode (`agent.chat_mode`), and
**chat stops being a tab inside a terminal window - it becomes the pane
itself** (decided, see decision #6):

- Metadata `SeparatedRow` (badges: type, status, verdict chip, branch, base
  selector, terminal/chat toggle, MR chip, created-ago) stays at the top in
  both modes.
- **Chat mode:** `ChatPane` fills the whole remaining pane height directly -
  transcript in the middle, composer docked at the bottom, its own sub-agent
  selector at the top. No `AgentTerminal` window framing, no fixed drag
  height, no `PromptBlock` (already skipped in chat mode today - the task is
  the first chat message). Bash shells stay reachable: the slim tab strip
  (agent tab + bash tabs + "+") survives as a one-row switcher at the top of
  the pane, but the *active view fills the pane* instead of living in a
  height-dragged window. With no bash tabs open, the strip collapses to just
  the "+" affordance (or hides behind one) so chat truly owns the pane.
- **Terminal mode:** same shell - the xterm agent tab plus bash tabs fill the
  remaining height and scroll internally. The row-snapping height-drag handle,
  `terminalHeight` in `agentViewPrefs` and the global chat-default-height pref
  (`chatPrefs.ts`) are all artifacts of the terminal being a window inside a
  scroll column; in the split they become dead weight (keep them only if the
  old stacked layout survives behind a flag, else remove).
- **Prompt collapsed by default (terminal mode only).** Wrap `PromptBlock` in a
  `CollapsibleCard` (or a lightweight disclosure) titled with a one-line
  truncated preview of the prompt, expandable on click. Persist the
  open/closed state per agent (reuse the `agentViewPrefs` pattern). This
  reclaims vertical space for the terminal. (Chat mode has no prompt block at
  all, so nothing to collapse there.)

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
httputil.NewSingleHostReverseProxy(...)` in `internal/preview/spawn.go`. Today
that proxy passes upstream responses through **untouched** (no `ModifyResponse`,
no body rewriting, no compression handling; `prefersHTML()` in
`internal/preview/proxy.go` only sniffs the *request* Accept header to decide
whether to serve Hydra's own loading page while the server boots). The upgrade
is a new `ModifyResponse` hook that, for HTML responses, **injects a small
bridge `<script>` before `</head>`**. That script runs *inside* the iframe at
the app's own origin, so it can read everything and `postMessage` up to the
parent Hydra window. The proxy is the bridge. This dissolves both cross-origin
problems:

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
  (extend `agentViewPrefs`). Default `diff`. Note this means no deep-linking:
  agent routes carry no search params today, so a tab choice in localStorage is
  not shareable/back-button-navigable. Acceptable for v1; a `?view=` search
  param can be layered on later if wanted.
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
   implicitly a feature. But chat mode is now a first-class persisted mode
   (`agent.chat_mode`, metadata-row toggle) and `ChatPane` reads fine in a
   narrow column - so this mainly affects terminal-mode heads, and the split
   even nudges toward chat mode. Not a blocker.
3. **Sticky-header re-scoping.** Removing the single `[data-main-scroll]`
   container breaks three things that assume it: the CSS-var docking
   (`--sticky-changes-h`, `FILE_STICKY_TOP`, `useMeasuredHeight`),
   `forwardSidebarWheelToMain` (wheel-forwards *to* `[data-main-scroll]`), and
   per-agent scroll restore in `agentViewPrefs`. All must be re-scoped to the
   right pane's own scroll container, and there are now two scroll contexts to
   persist. Two more couplings hide nearby: the file-list column's sticky
   `max-h-[calc(100vh-140px)]` is hard-coded viewport math that a shorter pane
   invalidates, and the Changes bar's `z-[25]` is deliberately kept below the
   sidebar scrim's `z-30` (see the comment in `DiffViewer.tsx`) - new stacking
   contexts could reintroduce that scrim-overlap bug.
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
7. **The archived-agent view is a second render path.** `AgentDetail.tsx` has
   *two* `[data-main-scroll]` containers - the active-agent page and a simpler
   archived-agent view (`ArchivedAgentDetail`) with its own metadata row.
   Decide whether archived agents get the split too or explicitly keep the
   single column (probably the latter - no live terminal to sit beside).
   Archived heads can now be *resumed* (revival recreates the worktree/branch
   and reopens the live page), so the single-column archived view is only ever
   one click away from the split layout - fine, just make sure the transition
   between the two render paths doesn't jar.
8. **Unmounting the diff unmounts its keyboard handlers.** `DiffViewer`
   registers window-level `keydown` handlers (merge-conflict fix flow, the
   B/H artifact-highlight toggle). With unmount-inactive-views (decision #4)
   those go dead whenever Tests/Previews is the active tab. Probably fine, but
   make it deliberate - or lift truly global shortcuts up.
9. **Group-by controls must relocate.** "Group by result"/"Group by scope"
   checkboxes live in the *diff* settings cog today (`SettingsPopup` in the
   Changes toolbar). Tests-as-a-view needs them moved into the Tests toolbar
   (row 2), else they'd be stranded in a different tab.

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
3. ~~**Which pane owns the metadata row?**~~ DECIDED: left pane, as proposed.
   It describes the agent/terminal side (type, status, branch, terminal/chat
   toggle) and keeping it there leaves the inspector chrome purely about the
   comparison.
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
5. ~~**Default split ratio**~~ DECIDED: 40% terminal / 60% inspector. The diff
   (especially side-by-side + file list) needs the extra room; chat mode reads
   fine at 40%.
6. ~~**Chat: tab of the terminal window, or the pane itself?**~~ DECIDED: in
   the new layout chat is **the pane itself**. Today `ChatPane` renders inside
   `AgentTerminal`'s tab strip, boxed in the same fixed-height drag window as
   the xterm; in the split, a chat-mode head's left pane *is* the chat -
   transcript fills, composer docks at the bottom, no window chrome. The tab
   strip survives only as a slim top-of-pane switcher for bash shells (and
   collapses/hides when there are none); the height-drag handle and the
   chat-default-height pref (`chatPrefs.ts`) don't apply in the split. The
   metadata row's terminal/chat toggle now swaps the whole pane's content
   (it already restarts the Claude process; the pane swap is the visual half
   of the same action).

## Affected files (first pass)

- `web/src/components/AgentDetail.tsx` - restructure the scroll region into the
  two-pane split; collapse `PromptBlock` (terminal mode); pick the left pane's
  occupant by `agent.chat_mode`.
- `web/src/components/AgentTerminal.tsx` - biggest single change on the left:
  drop the fixed-height window framing (height-drag handle, row-snap,
  `terminalHeight` / chat-default-height prefs) in favour of fill-pane; keep
  the tab strip as a slim top-of-pane switcher; in chat mode hand the pane to
  `ChatPane` directly.
- `web/src/components/AgentChat.tsx` - `ChatPane` itself barely changes (its
  chrome is internal); verify it lays out correctly as a flex-fill child
  instead of inside a fixed-px box.
- `web/src/lib/chatPrefs.ts` - the global chat-default-height pref has no role
  in the split; retire it (or keep it only while the stacked layout survives).
- `web/src/DiffViewer.tsx` - factor the tests/previews/artifacts cards out of
  the stacked layout; make Diff a standalone view; re-scope sticky CSS vars to
  the right pane.
- New: an inspector-pane container component owning the selector + view
  switching (e.g. `web/src/components/InspectorPane.tsx`).
- New: a split-pane primitive (or hand-rolled divider) + `StorageKeys` entry.
- `web/src/components/TestsPanel.tsx`, `PreviewPanel.tsx`, `ArtifactsPanel.tsx`
  - adapt from `CollapsibleCard` framing to first-class views (`ArtifactsPanel`
  keeps its per-set `CollapsibleCard`s; it mainly folds into the Diff view).
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
