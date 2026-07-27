# Web UI internals - agent page layout

Facts that matter when touching the agent page (`web/src/components/AgentDetail.tsx`
and `web/src/DiffViewer.tsx`):

- `AgentDetail.tsx` has **two render paths**: the active-agent page (always the
  split layout - a wide two-pane split or the narrow screen-stack; each pane owns
  its own scroll context, the inspector's marked `[data-inspector-scroll]`) and a
  simpler archived-agent view with a single `[data-main-scroll]` container.
  Layout changes must handle both.
- The agent page has no in-page header bar: both paths portal their status dot,
  title (inline rename) and action toolbar into the **global top bar** in
  `__root.tsx` via `TopBarPortal` (`web/src/lib/topBarSlot.ts` holds the slot
  element; `AgentTopBarContent` in `AgentTopBar.tsx` is the portalled content,
  including the width-measuring `AdaptiveActions` toolbar). Non-agent routes get
  a static crumb ("Repository" / "Settings") in the same slot. On the narrow
  layout the metadata row collapses to a one-line details disclosure above the
  chat.
- `DiffViewer.tsx` renders, in order: the sticky "Changes" toolbar (`LeftSelector` =
  base ref, `RightSelector` = head/target ref - both component-local `useState`,
  never lifted; stats, refresh, settings cog), then `TestsPanel` -> `PreviewPanel` ->
  `ArtifactsPanel`, then the file-list column + file diffs. Tests and previews wrap
  in `CollapsibleCard` (which fully unmounts its body ~200ms after collapse);
  `ArtifactsPanel` has no outer card but renders one `CollapsibleCard` per artifact
  set (each set's files in a masonry grid). The agent-page
  `ArtifactsPanel` is two-sided (base+head refs); `RepositoryArtifactsView` is the
  single-ref sibling used by the repository browser.
- Sticky-header coordination: `DiffViewer` publishes `--sticky-changes-h` via a
  ResizeObserver; `--sticky-section-h`, `FILE_STICKY_TOP` (DiffViewer) and
  `STICKY_CARD_TOP` (CollapsibleCard) dock section headers under it. The file-list
  column is `position: sticky` with hard-coded `max-h-[calc(100vh-140px)]` viewport
  math, and the Changes bar's `z-[25]` sits below the mobile sidebar panel's
  `z-40` in `__root.tsx`. The bar is styled to match the global top bar (same
  bg/border; `py-2.5` lands a single-line bar at h-12) but stays sticky inside
  the scroll container - its ref selectors must remain reachable deep in a diff.
- Lazy file bodies + **measured placeholders**: a file card's body stays an empty
  placeholder until the card first scrolls near the viewport (`near`, a one-way
  IntersectionObserver latch in `FileDiff`). The placeholder's height is not
  guessed - `bodyShape()` (`web/src/lib/diffBody.ts`, which also owns the pure
  segment/pair model `DiffViewer` renders from) says exactly which lines and
  expander rows the body will render, and `measureBodyHeight()`
  (`web/src/lib/diffMetrics.ts`) lays that text out in a hidden replica of a real
  row at the real width, letting the browser wrap it. Unified is one write+read
  per file ('\n'-joined lines in one `pre-wrap` cell wrap exactly as one row
  each); side-by-side needs a read per pair, because a row is as tall as its
  taller half. Runs through `queueMeasure`'s idle queue, so it lands shortly
  after load rather than during a scroll. The row classes live in `diffMetrics`
  so the replica and the real rows can't drift; `DiffViewer.test.tsx` renders a
  body and asserts `bodyShape` predicted its row/expander counts. In-tree images
  are the one body that can't be predicted (`estimateVisibleRows` is the crude
  fallback). Get this wrong and the document grows as you scroll - the scrollbar
  thumb visibly shrinks - which is what `diffScroll.ts`'s re-correcting rAF loops
  used to exist for.
- Copying out of the chat yields **markdown source**, not the flattened rendered
  text: the transcript's scroll container owns an `onCopy`
  (`copyTranscriptAsMarkdown` in `AgentChat.tsx`) that hands the selection to
  `selectionToMarkdown` (`web/src/lib/copyMarkdown.ts`), which walks the selected
  DOM and re-serializes headings, emphasis, inline code, links, lists (incl. task
  lists), blockquotes, fenced blocks with their language, and GFM tables.
  `MarkdownRenderer` marks the surfaces it owns with `data-md-root` /
  `data-md-code-block` + `data-md-lang`; everything else in the transcript (tool
  cards, diffs) is copied as plain text. When a selection covers *all* of a
  root's text (a whole message, or every message under a select-all) the walk is
  skipped entirely and the message's own source is copied verbatim - the
  renderer registers it in a `WeakMap` (`setMarkdownSource`, keyed by the root
  element, not a `data-` attribute, so a long transcript doesn't hold a second
  copy of every message). That keeps what a round-trip cannot recover: `*` vs
  `-` bullets, setext headings, reference-link definitions, table column
  padding, hard-wrap positions. (Table *alignment* the serializer does recover -
  remark-gfm leaves it on each cell as an inline `text-align`.) It deliberately mirrors what the browser
  itself would leave out - `user-select: none` subtrees and control labels
  (`<button>`), which a drag can't select in the first place - so taking over the
  copy event doesn't start pulling chrome into the clipboard. A selection that
  stays inside one code block copies the raw code, no fence.
- Per-agent view state lives in `web/src/lib/agentViewPrefs.ts`: a sharded
  localStorage store keyed per project+agent, 30-day TTL (terminal height, page
  scrollTop, collapsed diff files, bash tabs, tests-panel view toggles).
- `web/src/lib/storage.ts` is the `StorageKeys` registry. The left sidebar's
  state is two independent flags in the zustand `useSidebarStore`
  (`web/src/lib/sidebar.ts`): a persisted desktop `desktopCollapsed` preference
  and a transient mobile `mobileOpen` (never persisted, so crossing the 768px
  breakpoint can't pop the sidebar open; below it the sidebar is a full-screen
  panel under the top bar, no scrim). Sidebar *width* is plain `useState` in
  `__root.tsx` persisted with `readLocal`/`writeLocal(StorageKeys.sidebarWidth)`.
  `forwardSidebarWheelToMain` (`__root.tsx`) forwards leftover sidebar wheel
  delta into `[data-main-scroll]` / `[data-inspector-scroll]`.
- All resizing is hand-rolled pointer/mouse drag - no split-pane library: sidebar
  width (`__root.tsx`), diff file-list width (`DiffViewer.tsx`), terminal height
  (`AgentTerminal.tsx`).
- The preview reverse proxy (`internal/preview/spawn.go` + `proxy.go`) passes
  upstream responses through untouched: no `ModifyResponse`, no body rewriting, no
  gzip handling. `prefersHTML()` sniffs only the *request* Accept header, to decide
  whether to serve Hydra's own loading page while the server boots. `PreviewPanel`'s
  Open button is a `window.open` of the proxy URL; nothing in `web/src` embeds an
  iframe today.
