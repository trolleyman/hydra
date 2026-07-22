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
