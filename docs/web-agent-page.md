# Web UI internals - agent page layout

Facts that matter when touching the agent page (`web/src/components/AgentDetail.tsx`
and `web/src/DiffViewer.tsx`):

- `AgentDetail.tsx` has **two render paths**, each with its own `[data-main-scroll]`
  scroll container: the active-agent page (metadata `SeparatedRow` -> `PromptBlock` ->
  `AgentTerminal` -> `DiffViewer`, with `AgentTopBar` as a non-scrolling header above)
  and a simpler archived-agent view. Layout changes must handle both.
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
  math, and the Changes bar's `z-[25]` is deliberately below the sidebar scrim's
  `z-30` in `__root.tsx` (comment at the JSX explains why).
- Per-agent view state lives in `web/src/lib/agentViewPrefs.ts`: a sharded
  localStorage store keyed per project+agent, 30-day TTL (terminal height, page
  scrollTop, collapsed diff files, bash tabs, tests-panel view toggles).
- `web/src/lib/storage.ts` is the `StorageKeys` registry. The left sidebar's
  *collapsed* state persists via the zustand `useSidebarStore`
  (`web/src/lib/sidebar.ts`), but its *width* does not - width is plain `useState`
  in `__root.tsx` persisted with `readLocal`/`writeLocal(StorageKeys.sidebarWidth)`.
  `forwardSidebarWheelToMain` (`__root.tsx`) forwards leftover sidebar wheel delta
  into `[data-main-scroll]`.
- All resizing is hand-rolled pointer/mouse drag - no split-pane library: sidebar
  width (`__root.tsx`), diff file-list width (`DiffViewer.tsx`), terminal height
  (`AgentTerminal.tsx`).
- The preview reverse proxy (`internal/preview/spawn.go` + `proxy.go`) passes
  upstream responses through untouched: no `ModifyResponse`, no body rewriting, no
  gzip handling. `prefersHTML()` sniffs only the *request* Accept header, to decide
  whether to serve Hydra's own loading page while the server boots. `PreviewPanel`'s
  Open button is a `window.open` of the proxy URL; nothing in `web/src` embeds an
  iframe today.
