# Web UI internals - agent page layout

Facts that matter when touching the agent page (`web/src/components/AgentDetail.tsx`
and `web/src/DiffViewer.tsx`):

- `AgentDetail.tsx` has **two render paths**: the active-agent page (always the
  split layout - a wide two-pane split or the narrow screen-stack; each pane owns
  its own scroll context, the inspector's marked `[data-inspector-scroll]`) and a
  simpler archived-agent view with a single `[data-main-scroll]` container.
  Layout changes must handle both.
- A live Head whose API `workspace_kind` is `project_directory` uses the same
  inspector pane as an isolated `worktree` Head. It enters with the inspector
  collapsed, with that entry state resolved before the reused split-pane DOM is
  painted so the inspector does not animate out after navigation. **Show diff**
  reveals it without changing the persisted
  worktree-pane preference. Its default
  comparison is `Chat start -> Project directory`:
  the left ref is the immutable `workspace_base_ref` captured at spawn, and the
  right side is the shared checkout including uncommitted and untracked files.
  The inspector describes project state, not changes owned exclusively by that
  chat. Tests and previews use the selected right side; artifacts use both sides.
- Agent-to-agent navigation applies the destination pane widths without a
  transition. Width and screen-stack transitions are reserved for explicit pane
  toggles within the currently selected agent.
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
  The explanatory status and workspace chips keep the ordinary default cursor.
  A project-directory workspace tooltip pairs its project path with the shared
  blue directory icon treatment.
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
  `trailingGap` returns null and that expander falls back to its directional
  action without a Show all action;
  with it, `atFileEnd` also drops the expander outright when the last hunk
  provably ends at EOF (the old `trailingContext < currentContext` guess couldn't
  tell that from a file with more below, and drew an action that expanded to nothing).
  Every known gap presents labelled **Up 20 lines**, **Down 20 lines**, and/or
  **Show all N lines** actions with directional line icons; a middle gap has all
  three and a file edge has the two actions that make sense there.
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
  after load rather than during a scroll. WebKit has no `requestIdleCallback`, so
  its timer fallback budgets each slice from actual elapsed time and yields
  between expensive file measurements instead of blocking the desktop view. The
  row classes live in `diffMetrics`
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
- In the native WebKit desktop view, the Files section uses borders and
  backgrounds for separation without box shadows on its sticky header, file
  list, pager or diff cards. WebKit repaints those shadows across the
  changing/scrolling diff at a much higher cost than Chromium; even a small
  visible file can otherwise make the desktop inspector scroll at roughly half
  frame rate. Browsers and the Chromium desktop bridge retain the shadows.
- **When a prediction is wrong anyway, the correction must not be visible.** The
  prediction is exact for a plain file body but not for everything in one -
  `bodyShape` does not model inline review-comment rows, so a file carrying a
  thread mounts taller than its placeholder (79px for one thread, in the sim).
  Two things in `FileDiff` keep that from moving the page under the reader, and
  both are easy to undo by accident:
  - The wrapper's `transition-[height]` is the opening glide; closing a file is
    immediate. The same height is also where a
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
- Diff file headers show the detected syntax language as a lowlit control. Its
  picker searches the full Prism catalog by display name, grammar codename,
  alias, or mapped file extension, and a per-file override immediately
  re-highlights both sides. Jsonnet uses Hydra's bundled Jsonnet grammar.
  Machine-owned lockfiles and conventional generated paths carry an
  **Auto-generated** label and start folded once per page session. Marking a file
  **Viewed** also folds it immediately; unmarking it leaves the reader's current
  fold state alone.
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
- Chat file links keep the authored label in the prose and show a repository path
  in their tooltip. An absolute path inside the current head's worktree drops that
  implementation-specific prefix; a genuinely external absolute path remains
  explicit.
- Bash inspection output is sectioned by `web/src/lib/shellSections.ts`. Plain
  file reads such as `sed -n '40,80p'` render with syntax highlighting and the
  file's real line numbers beneath a ruled, tooltip-bearing file header. Numbered
  searches group consecutive results under the sans-serif path each row names;
  a full-width rule across the gutter and source marks each nonconsecutive jump
  within that file. Every text,
  file, and directory header wraps at the panel edge like an ordinary output
  line and sticks to the output scroller's top until the next header replaces
  it. Adjacent
  bounded reads keep their requested starts when their exact range lengths
  account for all returned lines. Adjacent bounded ranges of the same file do
  not need headings between them. When an unbounded boundary cannot otherwise
  be proved, agents print a static marker such as
  `printf '%s\n' '--- [file] web/src/App.tsx ---'`; the untyped
  `printf '%s\n' '--- Notes ---'` form creates an ordinary heading and `[dir]`
  selects the shared directory treatment. The older `[text]` spelling remains
  accepted for existing transcripts. File and directory marker values are exact
  paths without annotations such as `(continued)`. A Bash call with several
  unbounded sections puts the marker immediately before every command that
  produces one, including the first, and keeps reads bounded where possible so
  truncation cannot remove its boundary evidence. A constant `echo` is accepted,
  while `printf` is the canonical cross-shell spelling. The parser only consumes
  a marker when it can correlate it unambiguously with the constant-printing
  command. In a script where a numbered search immediately
  precedes a read of the same file, repeated search rows can pin the read's start
  even when an open-ended command ran before both: the search text and number
  must agree with the corresponding line in the read before the gutter is shown.
  A self-identifying search also pins the total output before it, so a bounded
  read after that search keeps its requested line numbers, including when the
  read is guarded with `|| true`.
  Unified diffs derive sticky file headers from each surviving `diff --git`
  boundary, so agents do not print redundant file markers around `git diff`.
  Captured Vitest and Jest failures retain the runner's structure: failure
  headings and verdicts, case file and suite hierarchy, exception names, stack
  locations, and numbered source excerpts receive distinct treatments. Source
  excerpts use the grammar inferred from the failed file, including TSX.
- Bash command cards render commands relative to the head's worktree or a review
  agent's detached checkout. Provider launch wrappers spelled as `bash`,
  `/bin/bash`, `/usr/bin/bash`, or `/usr/local/bin/bash` are omitted so the card
  shows the script itself. A command that ran elsewhere gets a reproducible `cd`
  preamble; when the script starts with a description comment, that comment stays
  first and the preamble follows it. Home-relative preambles keep `~` outside
  quotes so the shell expands it. A whitespace prefix shared by every command
  line is presentation indent and is removed while relative shell-block indent
  remains intact. A trailing `&& echo ...` or `|| echo ...` stays beside the
  command it reports instead of wrapping onto an orphaned line.
- Edit tool previews, including Codex multi-file edits, use the repository diff's
  code composition and row metrics: syntax tokens, changed-word overlays,
  whitespace marks, gutters, and the code surface palette match the
  corresponding file diff. Command and output panels use the same Code font size
  preference, while retaining their denser line spacing. A multi-file Edit puts
  the shared change-type icon immediately after each file path, shows that
  file's additions and deletions at the right, and shows their total in the tool
  header. A preview only shows file line numbers when the provider supplies a
  structured patch with real offsets; string fragments are not numbered from an
  invented line 1.
- The spawn composer uploads attachments against its selected project. A
  desktop-native image paste that arrives before any project is selected is
  ignored; when selection restoration and paste overlap, the current project
  store supplies the upload identity rather than a placeholder route.
- A fully loaded transcript starts with a ruled `Conversation began <time> ago`
  divider styled like the `Resumed <time> ago` process-resume divider. Its exact
  timestamp uses the shared selectable Tooltip rather than a native browser
  title. When the floating conversation selector or Plan control is present, the
  transcript reserves their first row so this divider remains visible at
  scroll-top.
- A pinned running chat follows new output until the user takes control. Wheel
  movement and a pointer press in the native scrollbar gutter cancel the active
  follow animation before scrolling begins, so dragging the thumb never fights
  a streaming update. History loading fires once per arrival in the top zone;
  an anchored prepend re-arms it after moving the preserved content clear, so a
  thumb held at the top deliberately continues paging. Reaching the bottom
  explicitly reacquires the pin. The optional coarse-wheel easing layer is a
  default-off browser feature flag, independent from bottom following.
- Keyboard hints use the shared `Kbd` / `ShortcutHint` components. Their fixed
  cap box optically lowers the glyph within the font line box, keeping fonts
  with asymmetric ascent/descent metrics vertically centred.
- Agent action labels stay compact in the adaptive top bar. Their tooltips carry
  the operational detail: review creation names the PR/MR forge, merge names the
  target branch, restart says which state is preserved, and kill says that the
  worktree is deleted.
- The shared confirmation dialog is opaque as soon as it mounts. While a modal
  dialog or fullscreen file lightbox is open, underlying native scrollbar chrome
  - including theme-painted borders and shadows - becomes transparent without
  removing its gutter; this prevents WebKitGTK from compositing scrollbars
  through the overlay without shifting the page. The
  lightbox's transparency backing shrink-wraps the displayed media, so viewport
  height clamping cannot expose checkerboard beside an opaque image. Hydra's thin
  app-wide scrollbar treatment is a separate default-off browser feature flag;
  otherwise scrollbars use native browser and operating-system chrome.
- The primary Merge action preflights the existing per-runner tests endpoint
  before opening its confirmation when the compact verdict is not already gated.
  This distinguishes no configured runners from an unknown verdict and catches a
  branch-tip verdict newer than the project-event snapshot, so a blocked merge
  opens the Force / Queue choice directly instead of after a normal confirmation.
- Codex `View Image` tool cards resolve their path-only result through the
  agent-files endpoint and use the shared thumbnail/lightbox treatment. A
  successful durable `tool_completed` event grants an exact absolute-path
  capability even when Codex omits its optional status field; explicit failures
  never grant it. Each chat store indexes these paths while loading/appending,
  so serving a thumbnail is an O(1) lookup rather than a transcript scan.
- Per-agent view state lives in `web/src/lib/agentViewPrefs.ts`: a sharded
  localStorage store keyed per project+agent, 30-day TTL (terminal height, page
  scrollTop, collapsed diff files, bash tabs, tests-panel view toggles, and the
  chat Plan disclosure). Switching through Chat, Review and Bash tabs preserves
  whether the Plan is open, and the panel waits for a measured pane width before
  mounting so it does not briefly lay itself out at an impossible width.
- Chat, Review and Bash tab labels use the interface font. The shell palette
  distinguishes terminal content without decorative window traffic lights.
- `web/src/lib/storage.ts` is the `StorageKeys` registry. The left sidebar's
  state is two independent flags in the zustand `useSidebarStore`
  (`web/src/lib/sidebar.ts`): a persisted desktop `desktopCollapsed` preference
  and a transient mobile `mobileOpen` (never persisted, so crossing the 768px
  breakpoint can't pop the sidebar open; below it the sidebar is a full-screen
  panel under the top bar, no scrim). The slide/width transition is armed only
  by an explicit toggle, so crossing the breakpoint swaps layouts without
  animating the mobile panel into or out of the desktop column. Sidebar *width*
  is plain `useState` in `__root.tsx` persisted with
  `readLocal`/`writeLocal(StorageKeys.sidebarWidth)`.
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
