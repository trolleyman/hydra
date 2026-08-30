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
- The metadata header separates identity from runtime configuration. Agent type,
  status, and workspace chip lead the identity row; project-directory heads place
  Edit/Read-only and Allow commits immediately after that chip. The configuration
  strip orders test verdict, network, Git access, branch selector, and run mode.
  A worktree head's branch selector edits base-branch metadata. A project-directory
  head's selector performs a normal non-forced checkout in the shared project
  root, so Git refuses a switch that would overwrite local changes.
- `SegmentedControl` is the shared one-of-many primitive for Terminal/Chat,
  Worktree/Project directory, and Edit/Read-only. Do not hand-roll another paired
  button treatment for these choices.
- `DiffViewer.tsx` renders, in order: the sticky "Changes" toolbar (`LeftSelector` =
  base ref, `RightSelector` = head/target ref - both component-local `useState`,
  never lifted; stats, refresh, settings cog), then `TestsPanel` -> `PreviewPanel` ->
  `ArtifactsPanel`, then the file-list column + file diffs. Tests and previews wrap
  in `CollapsibleCard` (which fully unmounts its body ~200ms after collapse);
  `ArtifactsPanel` has no outer card but renders one `CollapsibleCard` per artifact
  set (each set's files in a masonry grid). The agent-page
  `ArtifactsPanel` is two-sided (base+head refs); `RepositoryArtifactsView` is the
  single-ref sibling used by the repository browser.
- The commit range selectors keep every right-side commit selectable. Choosing a
  right endpoint that is not newer than the current left endpoint moves left to
  that commit's first parent, producing a one-commit diff; an already-valid
  multi-commit range stays intact. Commit responses carry `parent_sha` so the
  oldest commit uses its immutable parent rather than resolving a base branch
  name that may have advanced since the branch split. Shift-click and commit
  chips use the same parent-selection helper.
- Sticky-header coordination: `DiffViewer` publishes `--sticky-changes-h` via a
  ResizeObserver; `--sticky-section-h`, `FILE_STICKY_TOP` (DiffViewer) and
  `STICKY_CARD_TOP` (CollapsibleCard) dock section headers under it. The file-list
  column is `position: sticky` with hard-coded `max-h-[calc(100vh-140px)]` viewport
  math, and the Changes bar's `z-[25]` sits below the mobile sidebar panel's
  `z-40` in `__root.tsx`. The bar is styled to match the global top bar (same
  bg/border; `py-2.5` lands a single-line bar at h-12) but stays sticky inside
  the scroll container - its ref selectors must remain reachable deep in a diff.
- **Revealing context** has one model and one fallback. The bulk diff request
  ships each eligible file's whole content inline (`full_context=true`,
  `max_full_changes`/`max_full_lines` = `HIDDEN_FILE_THRESHOLD`/`FULL_MAX_LINES`),
  and `buildSegments` + a per-region `RevealMap` open the gaps client-side: no
  round-trip, and a click only ever grows the region it belongs to. Nothing here
  touches the scroll - the expander stays under the pointer and the new lines
  grow away from it (an earlier "keep the change below the gap pinned" scrolled
  the pane by the height of every reveal; see the note in `diffScroll.ts`).
  A file past the bulk caps arrives windowed (`-U3` hunks); the first click on
  one of its expanders calls `expandFileDiff`, which re-fetches **that one file**
  with `full_context` at the promotion caps (`PROMOTED_MAX_LINES`/
  `PROMOTED_MAX_CHANGES`) and promotes it into the model above for good. The
  click isn't lost: the windowed expanders name their region up front
  (`LEAD_REGION_ID` / `regionAfterHunk`, keyed the same way `buildSegments` keys
  regions) and record the reveal before the fetch lands. Only a file too big even
  for the promotion cap keeps the old `-U<wider>` re-fetch, whose context is a
  property of the whole file and so widens every hunk in it, not the gap clicked.
  A windowed file's expanders still say **how much** they hide: the gaps between
  hunks are bracketed by two hunk headers (`computeGap`), the run above the first
  hunk is measured from its start line (`leadingGap`), and the run below the last
  one comes from `total_lines` on the wire - the file's length, which the server
  fills in from the full read `getFullContextDiff` already does, so it costs no
  extra work and is simply absent for a file that read never covered. Without it
  `trailingGap` returns null and that expander falls back to a bare chevron;
  with it, `atFileEnd` also drops the expander outright when the last hunk
  provably ends at EOF (the old `trailingContext < currentContext` guess couldn't
  tell that from a file with more below, and drew a chevron expanding to nothing).
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
  used to exist for. The chosen **Code font and size** are inputs to this, not
  just to the paint (a family wraps at a different column, a size changes the row
  height outright), so both are in the measure effect's deps and the row classes
  carry the chosen size rather than a literal `text-xs` - see
  `CODE_TEXT`/`CODE_LEADING` in `diffMetrics` and the size note in
  `web/src/lib/fonts.ts`.
- **When a prediction is wrong anyway, the correction must not be visible.** The
  prediction is exact for a plain file body but not for everything in one -
  `bodyShape` does not model inline review-comment rows, so a file carrying a
  thread mounts taller than its placeholder (79px for one thread, in the sim).
  Two things in `FileDiff` keep that from moving the page under the reader, and
  both are easy to undo by accident:
  - The wrapper's `transition-[height]` is the collapse/expand glide, and the
    correction lands on that same height. Left to animate it turned a one-frame
    reflow into 200ms of the diff sliding - so the layout effect on `wrapperH`
    cancels the transition (set `none`, read `offsetHeight`, restore) whenever
    the height changed with no `bodyOpen` toggle behind it. It has to be
    cancelled *after* the fact like this: arming or disarming the class in the
    same commit as the height change does not reach Chrome in time (arming it
    only for the toggle made collapse snap instead of glide - measured).
  - The same effect adds the delta to `scrollTop` when the card is wholly above
    the viewport, because `InspectorPane` turns the browser's own scroll
    anchoring off (`[overflow-anchor:none]`) and nothing else puts the view
    back. It checks `overflowAnchor` first: the archived view's
    `[data-main-scroll]` still anchors, and correcting twice moves the view by
    double. This is also what keeps the **sticky file headers** attached - a
    header whose card slides out from under it goes on being painted where it
    was, so it reads as detached from its own card until the next scroll.
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
  Chat code gutters and section labels also carry `data-copy-skip`; do not rely
  on `user-select: none` alone, because WebKitGTK can include those nodes when a
  desktop selection crosses grid rows or block boundaries.
- Bash inspection output is sectioned by `web/src/lib/shellSections.ts`. Plain
  file reads such as `sed -n '40,80p'` render with syntax highlighting and the
  file's real line numbers. In a script where a numbered search immediately
  precedes a read of the same file, repeated search rows can pin the read's start
  even when an open-ended command ran before both: the search text and number
  must agree with the corresponding line in the read before the gutter is shown.
- Per-agent view state lives in `web/src/lib/agentViewPrefs.ts`: a sharded
  localStorage store keyed per project+agent, 30-day TTL (terminal height, page
  scrollTop, collapsed diff files, bash tabs, tests-panel view toggles, and the
  chat Plan disclosure). Switching through Chat, Review and Bash tabs preserves
  whether the Plan is open, and the panel waits for a measured pane width before
  mounting so it does not briefly lay itself out at an impossible width.
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
