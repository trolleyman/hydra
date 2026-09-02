// The screenshot shot list: every page the generator captures, as pure data.
//
// It lives apart from take-screenshots.ts (the engine that renders it) for one
// reason: the `click`/`clicks`/`hover` selectors in here are the part that rots
// silently. A UI change moves a control, the selector matches nothing,
// Playwright waits its full 30s and the shot is dropped with a single line in a
// log. Keeping the list importable lets the e2e suite walk these selectors
// against the same simulation server and fail at TEST time instead - see
// e2e/screenshot-selectors.spec.ts. Duplicating the selectors into that spec
// would just rot in the same way, one step removed.
//
// Pure data by construction: no functions, no closure over the engine's state.
// Every behaviour is a declarative flag (showArtifacts, openFilter, ...) that
// take-screenshots interprets.

export const MARKDOWN_DEMO_PROMPT =
  "Add **simple inline-markdown** rendering so prompts and the live-activity line aren't flat text.\n\n" +
  'Highlight `inline code`, *italic* and **bold** as you type. A long command in backticks like `go test ./internal/heads/... -run TestResumeLazy -count=1 -race -v` wraps across lines, each fragment keeping its own rounded background, and a line that contains `code` stays exactly as tall as a plain one.\n\n' +
  'Note: a literal `$ run-this-command --now` in the prompt is just code, not a command - that override is activity-only.\n\n' +
  'A fenced block renders as its own code chip:\n```ts\nconst seg = parseInline(text)\nrenderMarkdown(seg) // code/bold/italic\n```'

export const PASTED_TEXT_INSTRUCTION = 'The CI build started failing on main - here is the full log, figure out which step broke and why:'

export const PASTED_LOG_DEMO = [
  '$ go build ./...',
  '# github.com/trolleyman/hydra/internal/heads',
  'internal/heads/heads.go:212:14: undefined: resumeHeadOnBoot',
  'internal/heads/heads.go:233:9: cannot use sess (variable of type *session.Session)',
  '\tas session.Registry value in argument to reg.Adopt',
  'note: module requires Go 1.22',
  '$ go test ./internal/heads/...',
  'FAIL\tgithub.com/trolleyman/hydra/internal/heads [build failed]',
  'FAIL\tgithub.com/trolleyman/hydra/internal/session [build failed]',
  'make: *** [Makefile:14: test] Error 2',
  'Error: Process completed with exit code 2.',
].join('\n')

export const PASTED_HTML_DEMO = [
  '<section class="hero">',
  '  <h1>Spawn an Agent</h1>',
  '  <p>Describe what you need - and consider it done.</p>',
  '  <form class="spawn">',
  '    <label for="task">Task</label>',
  '    <textarea id="task" placeholder="Describe a task..."></textarea>',
  '    <div class="actions">',
  '      <button type="submit">Spawn</button>',
  '    </div>',
  '  </form>',
  '</section>',
].join('\n')

export const VIDEO_SEEK = 1.2

export const pages: {
  name: string
  path: string
  scrollTo?: string
  viewport?: { width: number; height: number }
  // Explicit viewport:: tag override. The axis is otherwise derived from the
  // capture width alone (narrow → mobile), which can't tell a landscape phone
  // (wide but short) from a tablet, so landscape/tablet shots set it directly.
  // One of mobile | mobile-landscape | tablet | tablet-landscape | desktop.
  viewportTag?: 'mobile' | 'mobile-landscape' | 'tablet' | 'tablet-landscape' | 'desktop'
  // CSS selector clicked once (after load, before capture) - used to open a
  // popover such as the repository branch selector so the screenshot
  // documents it.
  click?: string
  // CSS selector hovered (after load, before capture) - opens a hover-only
  // card tooltip (e.g. the "Merge queued" pill's explanation) so it's captured.
  hover?: string
  // CSS selectors clicked in sequence (each followed by a settle), then a
  // networkidle wait so any fetch a click kicks off has rendered before the
  // capture. Used by the branch-compare diff shots, where pressing the diff
  // button enters diff mode (and fetches the diff) and an optional second
  // click opens the popped-out compare branch selector.
  clicks?: string[]
  // A Playwright key chord pressed after load (e.g. 'Shift+Slash' for "?"),
  // with the focused element blurred first so it reaches the window-level
  // shortcut handler rather than being typed into a field. Used to open the
  // keyboard-shortcuts overlay the way a user does - by pressing `?`.
  pressKey?: string
  // Opens the Ctrl+` alt-tab project switcher and leaves it open for capture.
  // Unlike pressKey (a full down+up chord), this HOLDS Control down and taps
  // Backquote - the switcher commits and closes on Ctrl release, so a chord
  // would shut it again before the shot. Control is never released (the page
  // context is torn down after the capture). Needs >= 2 projects.
  openSwitcher?: boolean
  // Glob of a request to hold open (never fulfilled) so the page is captured
  // in its in-flight loading state - e.g. holding the repo file-contents
  // request so the loading spinner shows. With a request pending, networkidle
  // never fires, so the goto waits for the DOM instead and then for the
  // spinner to appear.
  holdRequest?: string
  // Seeds the diff viewer's image-diff comparison mode ('hydra-diff-image-mode')
  // before the app boots, so before/after image pairs render in the chosen
  // mode. Used by the artifacts (agent-1) page and by the repository
  // branch-compare diff's in-tree image shots (which read the same setting).
  imageDiffMode?: 'side-by-side' | 'ab' | 'slider' | 'onion'
  // Seeds the repository diff's one-file-at-a-time preference
  // ('hydra-repo-diff-single-file') before boot. Omit for the default
  // (one file at a time); set false to capture the all-files-stacked view.
  repoDiffSingleFile?: boolean
  // Expands the named artifact card (clicks its header) after load - used to
  // document the in-flight card's live, scrollable generation log.
  expandArtifact?: string
  // Types a query into the artifacts panel's search box after load - used to
  // document that search narrows like the tag filter (cards stay put, their
  // header counts reflect the narrowing) rather than removing non-matching
  // cards or auto-expanding them. Only meaningful on the artifacts (agent-1)
  // page; pair with imageDiffMode.
  searchArtifacts?: string
  // Expands the ready "screenshots" card and pins it to the top, then eager-loads
  // every tile image and waits for the masonry to settle - so the capture shows
  // the actual before/after artifacts (the card defaults to collapsed, which
  // otherwise leaves these shots showing only the header row). Only meaningful on
  // the artifacts (agent-1) page; pair with imageDiffMode.
  showArtifacts?: boolean
  // Ticks the "Highlight" checkbox on every before/after image tile (after
  // showArtifacts has expanded the card), so the magenta pixel-diff overlay
  // (DiffCanvas) is captured painted over each changed image. Only meaningful
  // with imageDiffMode 'ab' + showArtifacts - the AB switch and its Highlight
  // toggle only render in that mode, once the masonry tiles exist.
  highlightArtifacts?: boolean
  // Clicks the first before/after artifact image (after showArtifacts has
  // expanded the card and decoded the tiles) to open it in the fullscreen
  // lightbox. The lightbox is diff-aware: it shows the before/after comparator
  // (with a mode selector + ←/→ between files), opening in the tile's current
  // mode. Captures the viewport (the lightbox is a fixed overlay). Pair with
  // showArtifacts + imageDiffMode 'side-by-side' (whose tiles open on a plain
  // left-click).
  openArtifactImage?: boolean
  // After openArtifactImage, click the lightbox's mode selector to switch the
  // fullscreen comparator to this mode (by the selector's button label) - shows
  // before/after, onion, etc. working inside the lightbox. Only meaningful with
  // openArtifactImage.
  lightboxMode?: string
  // After openArtifactImage (+ any lightboxMode), magnify the lightbox comparator
  // with the scroll-wheel so the zoom/pan chrome - the bottom-right minimap and
  // "Reset view (N×)" button - is on screen, documenting the lightbox zoom feature.
  // The zoom is a pure function of the (fixed) wheel amount, so the shot stays
  // reproducible. Only meaningful with openArtifactImage.
  lightboxZoom?: boolean
  // Eager-loads every masonry tile image and waits for the layout to settle
  // before capturing - for the repository artifacts view, whose masonry is shown
  // without an expand step. Keeps the width-driven layout byte-reproducible
  // (lazy/off-screen tiles would otherwise load inconsistently). No-op when the
  // page has no masonry tiles.
  settleMasonry?: boolean
  // Attaches the given checkout-relative images to the spawn form's hidden
  // file input (each fed in named "image.png", so the form renumbers them
  // image1.png, image2.png ...) and then opens the lightbox by clicking the
  // first attachment chip - documents the fullscreen image viewer and the
  // numbered-paste naming. Captures the viewport (the lightbox is a fixed
  // overlay), and the upload request is stubbed so the chips settle instantly.
  attachImages?: string[]
  // Captures only the viewport (not the full page), unscrolled, so the shot
  // focuses on a page's header region - e.g. the agent detail title bar -
  // rather than the long content (terminal, diff) below it.
  viewportOnly?: boolean
  // Scrolls the matched element into the middle of the viewport (after any
  // click/settleMasonry steps), then captures the viewport - for content that
  // lives at the bottom of an inner scroll container the full-page capture
  // can't reach (the document body doesn't scroll). Used to reveal the
  // repository artifacts "Show build log" terminal.
  revealSelector?: string
  // Forces a coarse (touch) pointer: makes the `(hover: hover) and (pointer:
  // fine)` media query report false, so keyboard-only affordances (shortcut
  // hints) hide exactly as they do on a real phone. The harness otherwise only
  // sets a small viewport - Chromium still reports a fine mouse pointer - so a
  // mobile shot of a menu would wrongly show desktop shortcut hints. Set this on
  // the small-screen shots whose chrome is keyboard-gated.
  coarsePointer?: boolean
  // Stubs the upload-serving endpoint (GET /uploads/.../blob) with this
  // checkout-relative PNG, so a prompt block that references upload images
  // renders its attachment-chip thumbnails (and lightbox) from a fixed,
  // deterministic image - no real uploads dir needed. After load, waits for
  // the chips to render. Used by the agent-prompt-attachments shot.
  stubUpload?: string
  // Seeds an unsent spawn-prompt draft (both the compact + full layout keys)
  // before the app boots, so the spawn box renders pre-filled - used to
  // document the live inline-markdown highlighting (and its line-wrapping)
  // in the textarea overlay without driving keystrokes.
  seedPrompt?: string
  // Seeds the remembered agent→model map (StorageKeys.defaultModel) before
  // boot, so the spawn form's agent+model picker renders with a model already
  // selected (the trigger shows its label; the row is checked) - used to
  // document the model selector without driving clicks through the menu.
  seedModel?: Record<string, string>
  // Dispatches a real paste of `text` into the full-page spawn textarea
  // (with the upload endpoint stubbed so the chip settles instantly), to
  // document the large-text-paste behavior: a paste over the line threshold
  // is attached as a pasted-text-N.txt chip rather than dumped into the box.
  // `vscodeMode` adds the VS Code clipboard language tag so the paste reads
  // as code; `again` fires the paste twice so the second one inlines the
  // block for real - fenced as ```<vscodeMode> when it's code. Pairs with
  // tallSpawn (to show a tall inlined block) and seedPrompt (a typed task
  // above the chip).
  pasteText?: { text: string; vscodeMode?: string; again?: boolean }
  // Screenshot-only: enlarge BOTH spawn boxes (the compact sidebar box and
  // the full-page main box) so a seeded markdown draft reads in full rather
  // than scrolled, and widen the sidebar so the compact box has room. Purely
  // a capture-time override: box heights are set via injected JS after the
  // page settles, and the sidebar width is seeded into localStorage before
  // boot. The app's real default box/sidebar sizes are unchanged. Pairs with
  // seedPrompt.
  tallSpawn?: boolean
  // Screenshot-only: seed a narrow sidebar width before boot so a menu opened
  // from the sidebar header (the project switcher) is wider than the sidebar
  // itself - documenting that the portal-rendered menu overlays the content
  // instead of being clipped by the sidebar's `overflow-hidden`. Capture-time
  // override only; the app's default width is unchanged.
  narrowSidebar?: boolean
  // Opts this page into the new two-pane agent layout (terminal/chat left,
  // inspector pane right). The screenshots default to the classic stacked
  // layout so the existing agent-page shots are unaffected; only pages that
  // set this render the split. Needs a lg+ viewport (>= 1024px wide).
  // Focuses the full-page spawn textarea and selects ALL of its text after the
  // page settles, so the capture overlays the browser's selection band (which
  // marks the REAL, selectable text positions) on top of the highlight backdrop
  // - making any drift between the two layers obvious. Used to prove the fenced
  // code block highlighting stays glyph-aligned with the textarea. Pairs with
  // seedPrompt + tallSpawn.
  selectSpawnText?: boolean
  // Seeds the artifact tag filter (localStorage key built from project+agent)
  // before the app boots, so the artifacts panel renders with a filter applied.
  // Each array lists a scope's HIDDEN values (e.g. { theme: ['dark'] } drops
  // the dark shots) - documents the header tag filter actively in use plus the
  // per-file tag badges. Only meaningful on the artifacts (agent-1) page.
  tagFilter?: { scoped?: Record<string, string[]>; free?: string[]; changeThreshold?: number }
  // Opens a tag-filter dropdown by its button label (e.g. 'theme'), so the
  // capture documents the menu itself: the all/clear header and the value
  // checkboxes (all on by default). Only meaningful on the artifacts page.
  openFilter?: string
  // Hovers the artifacts panel's info (i) icon so its tooltip opens, after
  // scrolling the "Artifacts" heading to mid-viewport to give the upward-
  // opening tooltip room. Captures the viewport (the tooltip is a fixed
  // portal). Only meaningful on the artifacts (agent-1) page.
  artifactInfo?: boolean
  // Hovers the tests panel's info (i) icon with the "Tests" heading pinned
  // near the TOP of the viewport, so there's no room for the card above it
  // and it has to flip downward instead of being clipped off-screen - the
  // regression shot for the tooltip flip fix. Captures the viewport (the
  // card is a fixed portal). Only meaningful on a tests-panel agent page.
  testsInfo?: boolean
  // Expands the "screenshots" card, seeks its loader-animation.webm pair to
  // the given time (paused), and pins that row to the top - so the capture
  // shows the video diff viewer (VideoDiffView) directly rather than buried
  // in a collapsed "N changed" card. Captures the viewport. The seek lands a
  // mid-clip frame so the before/after progress bars differ; the page's
  // play() no-op keeps the pair paused so the frame is byte-stable. Only
  // meaningful on the artifacts (agent-1) page, paired with imageDiffMode.
  // `highlight` clicks the video's "Highlight" tab (the magenta per-frame
  // pixel-diff, which now lives inside Before/After) - pair with imageDiffMode 'ab'.
  videoDiff?: { seek: number; highlight?: boolean }
  // Settings only: turn OFF the "Enabled" switch on the seeded [[artifacts]]
  // and [[services]] entries (the EnabledToggle in web/.../SettingsComponents).
  // Flipping each to disabled both mutes/labels its card "Disabled" AND marks
  // the config dirty, so the bottom-pinned FloatingSaveBar appears - one shot
  // documenting the disabled-entry styling and the floating save affordance.
  // Pair with scrollTo: 'Diff Artifacts' so the two editors fill the viewport.
  disableSettingsEntries?: boolean
  // Scrolls the diff so the named file's header (a path substring) is pinned
  // beneath the sticky "Changes" toolbar, with part of that file's body
  // scrolled under the now-stuck header - documents the sticky file header
  // (and the file-list sidebar, which pins at the same Y). Waits for the
  // artifacts panel (WS-populated, untracked by networkidle) first so the
  // file's measured offset is stable. Only meaningful on an agent diff page.
  stickFile?: string
  // Drives the toast store (via the window.__hydraToast harness) to render a
  // single toast deterministically, then captures the viewport so the fixed
  // bottom-right toast is in frame. Used to document the notification toasts
  // (needs-input / finished / security-gate approval / cross-project), which
  // are transient and never fire from the static simulation. reset() clears
  // any toasts the app popped on load first, so the canvas shows just this one.
  toast?: {
    message: string
    type?: 'info' | 'success' | 'error' | 'warning'
    actions?: { label: string; variant?: 'primary' | 'danger' }[]
    // When set, the rich security-gate approval card is rendered instead of the
    // plain message row (mirrors ApprovalToastData in the toast store).
    approval?: {
      kind: string
      target: string
      agentName?: string | null
      agentId?: string | null
      projectId?: string | null
      rw?: string | null
      reason?: string | null
      url?: string | null
      argsPreview?: string | null
      crossProject?: string | null
    }
    // When set, the "<agent> <before> <status pill> <after>" row is rendered
    // (mirrors AgentTransitionToastData in the toast store).
    agentTransition?: {
      agentName: string
      agentId: string
      projectId: string
      status?: string
      icon?: 'merge-queued'
      before?: string
      after?: string
      projectName?: string | null
    }
  }
  // Restricts this page to a subset of themes. Defaults to both light+dark;
  // set e.g. ['dark'] to capture only the dark render (used where a shot only
  // needs to exist once).
  themes?: readonly ('light' | 'dark')[]
}[] = [
  { name: 'home', path: '/' },
  // The unread-changes indicator: the agent sidebar shows an amber dot on the
  // right of agents that went running→waiting/finished while you were away
  // (agent-2 in the simulation), and the project dropdown - opened here -
  // shows a per-project unread count badge, with a dot on the folder button
  // when other projects have updates waiting (see simulation.go ListProjects /
  // ListAgents and AgentSidebarItem).
  { name: 'unread-indicator', path: '/', click: 'button[aria-label="Select project"]' },
  // The uncommitted-changes warning next to the Repository button (the
  // simulation reports a dirty .hydra/config.toml - see simulation.go
  // GetRepositoryPushStatus), opened to its commit popover: the dirty path
  // list plus the prefilled message input and "Commit all" button.
  { name: 'uncommitted-changes-popover', path: '/project/sim-project/', click: '[data-testid="uncommitted-chip"]' },
  // The project switcher opened over a deliberately narrow sidebar. The menu
  // (fixed w-72) is far wider than the sidebar, so it must overlay the content
  // area rather than be clipped by the sidebar's `overflow-hidden` - verifies
  // the portal-rendered menu (mirrors the Ctrl+` switcher's forced-open state).
  { name: 'project-switcher-narrow', path: '/', click: 'button[aria-label="Select project"]', narrowSidebar: true },
  // The Ctrl+` alt-tab project switcher: a centered overlay listing projects
  // in last-visited order (each with its custom icon), the highlighted row
  // being the one committed on Ctrl release. Opened on a project page so the
  // current project (sim-project) is the most-recent, and the first tap lands
  // on the next one (mobile-app) - the classic alt-tab move. viewportOnly
  // since the overlay is a fixed, centered modal.
  { name: 'project-switcher', path: '/project/sim-project/', openSwitcher: true, viewportOnly: true },
  // Notification toasts (web/src/lib/useAgentNotifications.ts). These fire on
  // live status transitions / security-gate parks that the static simulation
  // never produces, so they're rendered deterministically via the toast
  // harness over the settings page (a route that loads no project agents, so
  // nothing else pops a toast). Messages mirror the real ones the hook emits.
  // 1. An agent crossed into needs_input - "<bot> <agent> transitioned to
  // <status pill>", the agent label linking to it; lingers 12s.
  {
    name: 'toast-needs-input',
    path: '/settings',
    toast: {
      message: '"Migrate auth providers to OAuth" transitioned to needs input',
      type: 'warning',
      agentTransition: { agentName: 'Migrate auth providers to OAuth', agentId: 'agent-2', projectId: 'sim-project', status: 'needs_input' },
    },
  },
  // 2. An agent finished - same row, green "finished" pill; auto-dismisses at 8s.
  {
    name: 'toast-finished',
    path: '/settings',
    toast: {
      message: '"Add renameable agent titles" transitioned to finished',
      type: 'success',
      agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', status: 'finished' },
    },
  },
  // 2a. A transition in ANOTHER project (the background count diff in
  // useAgentNotifications): the same card topped with the neutral gray
  // folder+project banner - the calm sibling of the approval card's
  // amber one (agent-approvals-another-project).
  {
    name: 'toast-finished-another-project',
    path: '/settings',
    toast: {
      message: 'Agent "Reconcile Stripe events" in project "payments-api" transitioned to finished',
      type: 'success',
      agentTransition: { agentName: 'Reconcile Stripe events', agentId: 'agent-md', projectId: 'sim-project', status: 'finished', projectName: 'payments-api' },
    },
  },
  // 2b. Merge-lifecycle toasts (AgentDetail armMerge/executeMerge + the
  // background auto-merge detector in agentStore): the same agent card, with
  // the pill/copy describing the merge instead of a status transition.
  // Queued (auto-merge armed) - text-only row (no pill), with the emerald
  // "merge queued" Clock tile instead of the bot.
  {
    name: 'toast-merge-queued',
    path: '/settings',
    toast: {
      message: 'Will merge "Add renameable agent titles" into main when it finishes and its tests pass',
      type: 'info',
      agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', icon: 'merge-queued', before: 'will merge into `main` when it finishes and tests pass' },
    },
  },
  // In-flight merge - persistent (dismissed when the POST settles), green
  // "merging" pill leading the row.
  {
    name: 'toast-merging',
    path: '/settings',
    toast: {
      message: 'Merging agent "Add renameable agent titles" into main...',
      type: 'info',
      agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', status: 'merging', before: '', after: 'into `main`...' },
    },
  },
  // Merge landed - green "merged" pill (also what a background auto-merge pops).
  {
    name: 'toast-merged',
    path: '/settings',
    toast: {
      message: 'Agent "Add renameable agent titles" merged into main',
      type: 'success',
      agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', status: 'merged', before: '', after: 'into `main`' },
    },
  },
  // 2c. A plain message toast with a `backtick` branch pill - the sidebar
  // Sync button's success toast (usePushStatus).
  {
    name: 'toast-synced',
    path: '/settings',
    toast: { message: 'Synced with `origin/main`', type: 'success' },
  },
  // 3. Security-gate approval cards (the rich ApprovalCard): persistent, with
  // Allow once / Always allow / Deny; dismissing denies. These are the ONLY
  // shots that render an approval card - the simulated agents never park a
  // live approval (see simulation.go), so the global toasts don't leak onto
  // every screen. One `agent-approvals-*` shot per gated kind documents each
  // design, over /settings (a route that loads no project agents). agentId +
  // projectId point the clickable agent subtitle at a real simulated agent.
  // 3a. Whole MCP server.
  {
    name: 'agent-approvals-mcp',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow once', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'mcp', target: 'linear', agentName: 'Wire up the GitHub MCP server', agentId: 'agent-approval', projectId: 'sim-project' },
    },
  },
  // 3b. A specific write tool on an already-trusted server - amber WRITE badge,
  // arguments shown as highlighted JSON in the code box.
  {
    name: 'agent-approvals-tool-write',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow once', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'mcp_tool', target: 'linear__create_issue', rw: 'write', agentName: 'Triage inbound bugs', agentId: 'agent-approval', projectId: 'sim-project', argsPreview: '{"team":"Core","title":"Login 500s on staging","priority":2,"labels":["bug","regression"]}' },
    },
  },
  // 3c. A read-only tool call - quieter, teal READ badge.
  {
    name: 'agent-approvals-tool-read',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow once', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'mcp_tool', target: 'linear__search_issues', rw: 'read', agentName: 'Summarise this sprint', agentId: 'agent-approval', projectId: 'sim-project', argsPreview: '{"state":"Done","cycle":42}' },
    },
  },
  // 3d. An outbound WebFetch - NETWORK badge + URL, and the caption spelling
  // out that allowing trusts the whole host (every request, including POSTs).
  {
    name: 'agent-approvals-webfetch',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      // webfetch/egress allows are session-wide host grants, so the primary
      // button is "Allow" (not "Allow once") - see useAgentNotifications.
      actions: [
        { label: 'Allow', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'webfetch', target: 'docs.linear.app', agentName: 'Publish the changelog', agentId: 'agent-approval', projectId: 'sim-project', url: 'https://docs.linear.app/api/changelog' },
    },
  },
  // 3e. A blocked egress host: the agent's proxy hit a host on neither the
  // allow- nor block-list, so the connection is parked. Allow opens it
  // for the session; Always allow adds it to the network allow-list.
  {
    name: 'agent-approvals-egress',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'egress', target: 'telemetry.example.com', agentName: 'Add crash reporting', agentId: 'agent-approval', projectId: 'sim-project' },
    },
  },
  // 3f. A host filesystem path: the canonical file/directory is shown in full,
  // with the sandbox restart and grant lifetime made explicit.
  {
    name: 'agent-approvals-filesystem-read',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow once', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'filesystem_read', target: '/opt/acme-sdk/include', agentName: 'Build the native extension', agentId: 'agent-approval', projectId: 'sim-project', description: 'I need the installed SDK headers to compile the project native extension.' },
    },
  },
  // 3g. The sandbox escape hatch: the agent asks to run a command on the HOST,
  // outside its sandbox (`hydra host-run`). Loud red HOST identity, the full
  // command shown in a red mono box - chain-split (a newline per top-level
  // ;/&&), line-numbered and bash syntax-highlighted for auditability - and
  // one-shot only (no Always allow), the most dangerous ask there is. The
  // target is a chained command so the shot exercises the splitting, the
  // gutter and the highlighting.
  {
    name: 'agent-approvals-host-command',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow once', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'host_command', target: 'cd "$HOME/tools" && ./gen-certs.sh --local ; security add-trusted-cert -d dev-root.pem', agentName: 'Set up local HTTPS certs', agentId: 'agent-approval', projectId: 'sim-project' },
    },
  },
  // 3h. An agent running in ANOTHER project: an amber folder+project
  // banner. Always allow is still offered (a remembered grant is
  // scoped to the project the approval resolves in).
  {
    name: 'agent-approvals-another-project',
    path: '/settings',
    toast: {
      message: '',
      type: 'warning',
      actions: [
        { label: 'Allow once', variant: 'primary' },
        { label: 'Always allow', variant: 'primary' },
        { label: 'Deny', variant: 'danger' },
      ],
      approval: { kind: 'mcp', target: 'github', agentName: 'Reconcile Stripe events', crossProject: 'payments-api' },
    },
  },
  // The keyboard-shortcuts help overlay, opened the way a user does - by
  // pressing `?` (no on-screen button; the overlay is the discovery surface).
  // It lists every shortcut (General + Agent) from the central registry
  // (web/src/lib/shortcuts.ts). Captured over the project home; viewportOnly
  // since the overlay is a fixed, centered modal.
  { name: 'keyboard-shortcuts', path: '/project/sim-project/', pressKey: 'Shift+Slash', viewportOnly: true },
  // The spawn form's image lightbox: two images attached to the prompt, the
  // first opened in the Slack-style fullscreen viewer (blurred backdrop,
  // prev/next arrows, "1 / 2" counter). Also shows the numbered-paste naming
  // (image1.png) on the chips behind. Rendered on the full-page spawn form.
  { name: 'spawn-image-lightbox', path: '/project/sim-project/', attachImages: ['web/public/android-chrome-512x512.png', 'web/public/apple-touch-icon.png'] },
  // The full-page spawn form's base-branch selector, opened so the capture
  // documents the dropdown: the current branch (HEAD), agent branches, and
  // other branches. Verifies the menu renders below the "from" trigger and
  // escapes the spawn card's `overflow-hidden` clipping (the BranchSelector
  // portal fix) - the bug where the dropdown didn't show when selected. The
  // branch list comes from the simulation server. Scoped to .max-w-4xl so it
  // opens the full-page form's selector, not the compact sidebar box's (both
  // carry the same title).
  // The base-branch control lives inside the "Spawn options" popover now, and
  // that popover is PORTALLED to <body> - so it escapes both `.max-w-4xl` and
  // `aside`, and the scope that tells the full-page form from the sidebar's has
  // to sit on the button that opens it, not on the selector itself.
  { name: 'spawn-branch-selector', path: '/project/sim-project/', clicks: ['.max-w-4xl button[aria-label="Spawn options"]', 'button[data-branch-selector]'] },
  // The same dropdown opened from the compact spawn box in the top-left
  // sidebar (the mini form rendered on every project page). Scoped to the
  // `aside` so the click lands on the sidebar selector rather than the
  // full-page form's (both carry the same "Base branch" title). Verifies the
  // portal-rendered menu escapes the narrow sidebar's clipping too.
  { name: 'spawn-branch-selector-mini', path: '/project/sim-project/', clicks: ['aside button[aria-label="Spawn options"]', 'button[data-branch-selector]'] },
  // The inline-markdown rendering (the markdown-pass feature). The spawn box
  // is seeded with a markdown draft so the textarea overlay shows live
  // highlighting - `code`, *italic*, **bold**, and a long inline-code
  // reference wrapping across lines - and the sidebar shows the rendered
  // live-activity lines: agent-md's markdown activity and agent-3's
  // "$ ..."-command activity (rendered wholly as code, overriding markdown).
  // Full-page so both the box and the sidebar activity land in one shot.
  // tallSpawn enlarges both spawn boxes (capture-only) so the whole seeded
  // draft, fenced code block included, is visible without scrolling.
  { name: 'spawn-markdown', path: '/project/sim-project/', seedPrompt: MARKDOWN_DEMO_PROMPT, tallSpawn: true },
  // The same seeded markdown draft with the whole spawn box selected. The
  // browser's selection band marks where the REAL (selectable) textarea text
  // sits, painted over the highlight backdrop - so the two layers can be
  // checked for drift at a glance. The acid test is the fenced ```code``` block
  // (and the blank line that hugs it): the selection rows must land exactly on
  // the highlighted rows, proving the inline-block code block stays glyph-aligned
  // with the textarea. tallSpawn shows the whole draft (block included) unscrolled.
  { name: 'spawn-markdown-selected', path: '/project/sim-project/', seedPrompt: MARKDOWN_DEMO_PROMPT, tallSpawn: true, selectSpawnText: true },
  // A large text paste turned into an attachment. Pasting a block over the
  // line threshold (a CI log here) doesn't fill the textarea - it lands as a
  // pasted-text-1.txt chip below it, the same chip the file uploads use, so
  // the typed task above stays readable. Documents the
  // attach-pasted-text-instead-of-inlining behavior on the full-page form.
  { name: 'spawn-pasted-text', path: '/project/sim-project/', seedPrompt: PASTED_TEXT_INSTRUCTION, pasteText: { text: PASTED_LOG_DEMO } },
  // The code-paste path: pasting an HTML snippet copied from an editor
  // attaches it on the first paste, and pasting it AGAIN inlines it for real
  // - wrapped in a ```html fence (the clipboard's language tag) so it renders
  // as a fenced code block in the highlight overlay. `again` fires both
  // pastes; tallSpawn enlarges the box so the whole fenced block shows.
  { name: 'spawn-pasted-code', path: '/project/sim-project/', pasteText: { text: PASTED_HTML_DEMO, vscodeMode: 'html', again: true }, tallSpawn: true },
  // The agent-detail prompt block rendering the same markdown: code/bold/
  // italic, an inline-code span that wraps, the tightened gap under the
  // metadata row, and the soft bottom fade as the tall prompt scrolls out of
  // view. Viewport-only to focus on the header + prompt (agent-md's seeded
  // prompt overflows the block's max height, so the fade is visible).
  { name: 'agent-markdown', path: '/project/sim-project/agent/agent-md', viewportOnly: true },
  // The two-pane split layout: the terminal/chat + collapsed prompt in the left
  // working pane, and the inspector pane on the right. A wide viewport is
  // required. It used to be opt-in per shot via a `splitLayout` flag; 0274e040
  // made it always-on and deleted the storage key that flag wrote, so the flag
  // (and the third shot, which clicked a Diff|Tests|Previews segment that no
  // longer exists) are gone. The Tests panel has its own tests-panel* shots.
  { name: 'agent-split-diff', path: '/project/sim-project/agent/agent-1', viewport: { width: 1440, height: 900 }, viewportOnly: true },
  { name: 'agent-split-chat', path: '/project/sim-project/agent/agent-chat', viewport: { width: 1440, height: 900 }, viewportOnly: true },
  // The tests panel (PLAN #68), now styled like the artifacts panel and living
  // in the diff viewer just below the "Changes" header. Pin Changes to the top,
  // then expand agent-2's single (failing) runner card by clicking its header -
  // its fixtures (simTestRunners) are a regression with two failing cases, so
  // the card shows the assertion messages failing-first.
  { name: 'tests-panel', path: '/project/sim-project/agent/agent-2', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)'] },
  // (There used to be a tests-panel-grouped shot here, reached by ticking
  // "Group by result" in the options cog. Group-by-result is now the DEFAULT, so
  // tests-panel above already captures that view and the click only turned it
  // back OFF - the shot showed the opposite of its name. If the by-location tree
  // is worth its own shot, add one that says so rather than reviving this.)
  // The same surface mid-run (agent-md is seeded as a running verdict): the
  // expanded card's live xterm build-log tail + progress bar + partial counts.
  { name: 'tests-panel-running', path: '/project/sim-project/agent/agent-md', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)'] },
  // The indeterminate progress bar: agent-md's second runner ("eslint") is a
  // streamed run with no declared ::hydra:test:total::, so it has no fill
  // percentage - the bar is a full-width sliding "barber pole" of diagonal
  // stripes ("working, length unknown") rather than a partial fill. Expand
  // that card by its name so the striped bar sits under the live counts.
  { name: 'tests-panel-running-indeterminate', path: '/project/sim-project/agent/agent-md', scrollTo: 'Changes', clicks: ['button:has-text("eslint")'] },
  // The tests panel's info (i) card hovered with its heading pinned near the
  // top of the viewport: the tall card has no room above, so it opens DOWNWARD
  // with its arrow pointing up - the regression shot for the tooltip flip fix
  // (it used to be hard-coded to open upward and clipped off the top here). The
  // short viewport scrolls the terminal away so the Tests icon sits high on
  // screen, the condition that triggered the clip; testsInfo does the pin+hover.
  { name: 'tests-info-tooltip', path: '/project/sim-project/agent/agent-2', testsInfo: true, viewport: { width: 1280, height: 460 } },
  // The merge gate in the header (PLAN #68): the primary button always reads
  // "Merge" now; opening its split-button dropdown on agent-2's failing verdict
  // reveals the soft-gate warning plus the Force merge / Queue merge overrides.
  { name: 'tests-merge-gate', path: '/project/sim-project/agent/agent-2', viewportOnly: true, click: 'button[aria-label="Merge options"]' },
  // The force-merge confirm that names exactly what's being overridden - reached
  // by opening the merge dropdown and choosing Force merge.
  { name: 'tests-force-merge-confirm', path: '/project/sim-project/agent/agent-2', viewportOnly: true, clicks: ['button[aria-label="Merge options"]', 'button:has-text("Force merge")'] },
  // The merge-and-continue confirm (merge with close=false): reached from the
  // merge dropdown's "Merge and continue" on agent-1 (finished, no test
  // verdict, so the un-gated variant) - the copy promises the agent keeps
  // running instead of "closes the session".
  { name: 'merge-and-continue-confirm', path: '/project/sim-project/agent/agent-1', viewportOnly: true, clicks: ['button[aria-label="Merge options"]', 'button:has-text("Merge and continue")'] },
  // Auto-merge armed: agent-md (running + merge_when_green) shows the green
  // "merges when tests pass" metadata chip, and the merge button becomes the
  // green "Merges when tests pass" pill with its own Cancel button.
  { name: 'tests-merge-when-green', path: '/project/sim-project/agent/agent-md', viewportOnly: true },
  // Chat mode: agent-chat renders the chat view instead of a
  // terminal - user bubble, markdown-rich assistant turns, tool cards, a
  // thinking disclosure, per-turn footers and the Claude-app composer - plus
  // the terminal|chat mode chip in the metadata row.
  //
  // This used to expand the Bash card by clicking its description header. That
  // header is no longer a control (tool cards render as role="button" divs, and
  // this one is not reliably mounted in the transcript), and the shot is about
  // the chat view as a whole rather than that one card - so it captures the
  // default state. A dedicated expanded-Bash-card shot would need a selector
  // that targets the card itself.
  { name: 'agent-chat', path: '/project/sim-project/agent/agent-chat', viewport: { width: 1920, height: 1080 }, viewportOnly: true },
  // Sub-agent (Task tool) handling: a sub-agent's steps fold into a single
  // SubagentCard on its Task card (Bot icon, "Explore" type, description,
  // step count) instead of leaking its prompt into the flow as a user
  // message. Expanded here to show the folded Prompt, inner timeline and
  // Report.
  { name: 'agent-chat-subagent', path: '/project/sim-project/agent/agent-chat', viewport: { width: 1920, height: 1080 }, viewportOnly: true, click: 'button:has-text("Audit upload retry tests")' },
  // Native AskUserQuestion: agent-ask is parked on a
  // live question card - radio + multi-select checkbox options with
  // descriptions, Other fields and the Submit all button.
  { name: 'agent-ask-question', path: '/project/sim-project/agent/agent-ask', viewportOnly: true },
  // The "Merge queued" pill's hover hint, on an agent whose queued merge is
  // blocked on the AGENT rather than the tests: agent-queued armed auto-merge
  // (tests already green) but hasn't reached a finished state, so the hint
  // reports it's "Waiting on the agent to finish". Hovering the pill opens the
  // hint; viewportOnly frames the header + hint.
  { name: 'merge-queued-tooltip', path: '/project/sim-project/agent/agent-queued', viewportOnly: true, hover: 'text=Merge queued' },
  // The merge-gate dialog (PLAN #68): clicking the plain "Merge" button on
  // agent-2's failing verdict opens the Force-merge / Queue-merge choice with an
  // explanation of the soft gate, instead of bouncing off a server 409.
  { name: 'tests-merge-gate-dialog', path: '/project/sim-project/agent/agent-2', viewportOnly: true, click: 'button[aria-label="Merge"]' },
  // A fully-expanded tests runner card: agent-2's vitest card opened, then the
  // status filter switched to "all" so the failing cases, the passing case and
  // the skipped row are all visible together as a folder/file/scope tree below
  // the Changes header. The scope levels are vitest describe blocks, so they
  // render with the module ({}) glyph and a file-icon-led location chain (the
  // dropdown is dismissed by clicking the Tests heading before the capture).
  { name: 'tests-card-expanded', path: '/project/sim-project/agent/agent-2', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)', 'button:has-text("status")', 'button:text-is("all")', 'h3:has-text("Tests")'] },
  // The counterpart with FUNCTION-kind scopes: agent-1's Go "go" runner, whose
  // two Go cases carry a `func TestXxx` subtest parent → the ƒ function glyph
  // (vs agent-2's {} module describe blocks), amid a real dir/file tree.
  { name: 'tests-card-functions', path: '/project/sim-project/agent/agent-1', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)', 'button:has-text("status")', 'button:text-is("all")', 'h3:has-text("Tests")'] },
  // The merge-gate dialog while tests are still running: agent-3 (running, not
  // armed) - clicking Merge offers "Merge now" (don't wait) or Queue merge, over
  // a blue running tile + a progress chip.
  { name: 'tests-merge-gate-dialog-running', path: '/project/sim-project/agent/agent-3', viewportOnly: true, click: 'button[aria-label="Merge"]' },
  // The merge gate when the AGENT (not the tests) isn't ready: agent-approval is
  // blocked asking you a question (needs_input), so clicking Merge warns "Agent
  // is waiting on you" and reuses the Force merge / Queue merge / Cancel choice -
  // Queue arms merge-when-green so it lands once the agent finishes and is green.
  { name: 'merge-agent-active-dialog', path: '/project/sim-project/agent/agent-approval', viewportOnly: true, click: 'button[aria-label="Merge"]' },
  // The agent + model picker dropdown, opened on the compact ("mini") spawn
  // box in the sidebar. The picker is a compact trigger (the active agent's
  // brand mark + the chosen model's short label) that opens a menu grouping
  // every agent type with its curated models nested underneath - so agent AND
  // model are chosen in one gesture (web/src/components/SpawnForm.tsx). This
  // shot documents the brand icons/accents and the nested model rows.
  // Captured on an agent page (not the project landing) so the sidebar's
  // compact box is the only spawn form on screen - the full-page box would
  // otherwise add a second, identical picker and make the click ambiguous.
  // viewportOnly: the menu is a fixed overlay anchored to the trigger at the
  // top-left, so the default viewport already frames both the box and menu.
  { name: 'spawn-agent-picker', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button[aria-label^="Agent and model:"]' },
  // The same picker with a model already selected (seeded Claude → Opus 5): the
  // compact trigger shows the model label beside the brand mark, and the open
  // menu shows the nested per-agent model rows with Opus 5 checked. Documents
  // the model selector's selected state (the picked model is remembered per
  // agent type in StorageKeys.defaultModel and pins the CLI's --model at spawn).
  { name: 'spawn-model-picker', path: '/project/sim-project/agent/agent-1', viewportOnly: true, seedModel: { claude: 'claude-opus-5' }, click: 'button[aria-label^="Agent and model:"]' },
  // The repository view: a GitHub-style browser with a file/folder tree on
  // the left and the picked file rendered on the right. Simulation mode
  // serves a small mock repo (see internal/http/simulation.go) and opens
  // README.md by default, so the capture shows rendered markdown beside the
  // tree. Full-page; the layout fills the viewport with internal scroll.
  { name: 'repository', path: '/project/sim-project/repository' },
  // The repository view's loading state: while a file's contents are being
  // fetched the main pane shows a centered spinner (not the previously shown
  // file), so switching files never flashes stale content. We hold the
  // file-contents request open so the capture lands mid-load - the tree
  // populated on the left, the spinner on the right. (The file request only
  // fires once branches + tree have loaded, so holding it implies both are
  // already rendered.)
  { name: 'repository-loading', path: '/project/sim-project/repository', holdRequest: '**/repository/file*' },
  // The repository view showing a source file: a deep-linked URL
  // (/repository/<ref>/<path>) renders the file with line numbers and the
  // tree auto-expanded down to it (folders are otherwise collapsed). Demos
  // line numbers, soft-wrapping, and URL routing.
  { name: 'repository-code', path: '/project/sim-project/repository/main/internal/server/server.go' },
  // The "raw" file view: the file header's Raw button (and the image
  // preview's copy/raw controls) open the unrendered blob in a new tab,
  // served by the /repository/.../blob endpoint and rendered by the browser
  // as plain text - GitHub's "raw" page. We navigate straight to that blob
  // URL to document where the Raw button lands. Theme doesn't affect the
  // browser's plain-text rendering, so the light/dark shots match.
  { name: 'repository-raw', path: '/api/projects/sim-project/repository/blob?path=internal/server/server.go&ref=main' },
  // The branch selector opened over the source-file view: Hydra agent
  // branches (hydra/*) are listed first.
  {
    name: 'repository-branches',
    path: '/project/sim-project/repository/main/internal/server/server.go',
    click: 'button[data-branch-selector]',
  },
  // The branch-compare diff view: the diff button (the GitCompare icon beside
  // the branch selector) opens the branch dropdown; picking a branch diffs it
  // against the browsed ref. The sidebar header becomes "base → head" and the
  // main pane shows the diff (reusing the agent diff's FileDiff/FileRow), with
  // per-file line counts and added/removed/renamed change-type tags.
  // Simulation serves a small mock diff with one of each change type (see
  // GetRepositoryDiff in internal/http/simulation.go). The default is one file
  // at a time - the main pane shows only the file selected in the left list.
  {
    name: 'repository-diff',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")'],
  },
  // The same diff with the all-files-stacked view (a stored preference,
  // toggled in the diff settings popup): every changed file's diff is shown
  // at once rather than one at a time.
  {
    name: 'repository-diff-all',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")'],
    repoDiffSingleFile: false,
  },
  // One file at a time, selecting each change type from the left list (the
  // third click). heads.go is a full-context ("expanded") file, so its diff
  // shows surrounding context collapsed behind ⌄/⌃ "··· N lines ···"
  // expanders - documenting how context is handled.
  {
    name: 'repository-diff-context',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("heads.go")'],
  },
  // A removed file: the whole file shows as deletions, with the red removed tag.
  {
    name: 'repository-diff-removed',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("old_helper.go")'],
  },
  // An added file: the whole file shows as additions, with the green added tag.
  {
    name: 'repository-diff-added',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("lines.go")'],
  },
  // A renamed file: the header shows "old → new" path with the renamed tag.
  {
    name: 'repository-diff-renamed',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("renderer.go")'],
  },
  // A modified in-tree image: the diff viewer renders the artifacts panel's
  // before/after image differ (ImageDiffView) in place of "Binary file
  // changed", obeying the shared image-diff mode setting. Click the changed
  // image in the file list; side-by-side mode shows before and after at once
  // (the sim serves a different picture per ref, so they visibly differ).
  {
    name: 'repository-diff-image',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("diff-banner.png")'],
    imageDiffMode: 'side-by-side',
  },
  // An added in-tree image: only the after side exists, so the differ shows
  // the new image beside a "No image" before placeholder.
  {
    name: 'repository-diff-image-added',
    path: '/project/sim-project/repository',
    clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("diff-added.png")'],
    imageDiffMode: 'side-by-side',
  },
  // The diff branch selector reopened while diffing: the dropdown checkmarks
  // the current compare branch, and clicking that branch (or the base) exits
  // diff mode. Enters diff mode first (open dropdown, pick a branch), then
  // reopens the now-labelled compare selector to document the checkmark.
  {
    name: 'repository-diff-branches',
    path: '/project/sim-project/repository',
    clicks: [
      'button[aria-label="Compare with another branch"]',
      'button:has-text("hydra/add-line-numbers")',
      // Select the full-context heads.go file so the diff visibly fills the
      // pane behind the dropdown (README's 4-line diff sat entirely under it,
      // reading as an empty/loading pane); then reopen the branch selector to
      // showcase the agent-vs-other branch grouping.
      'button:has-text("heads.go")',
      'button[data-branch-selector]:has-text("hydra/add-line-numbers")',
    ],
  },
  // A binary image file rendered inline via the raw blob route.
  { name: 'repository-image', path: '/project/sim-project/repository/main/web/public/logo.png' },
  // A symbolic link: opening server-link.go renders the file it points at
  // (internal/server/server.go) with a "→ target" indicator in the header,
  // demonstrating symlink support.
  { name: 'repository-symlink', path: '/project/sim-project/repository/main/server-link.go' },
  // The file-not-found state: a deep link to a path that doesn't exist at the
  // ref renders a dedicated "File not found" page rather than a raw error.
  { name: 'repository-not-found', path: '/project/sim-project/repository/main/does/not/exist.md' },
  // Compact folders: a single-child directory chain
  // (config/env/staging/region/eu) renders on one row, VS Code style, just
  // like the diff viewer's tree. Deep-linking the leaf file auto-expands the
  // chain so the compacted row is visible.
  { name: 'repository-compact-folders', path: '/project/sim-project/repository/main/config/env/staging/region/eu/settings.toml' },
  // The repository view's artifacts viewer: the dynamic ".hydra/artifacts"
  // folder (nested under the real .hydra/ folder) lists each configured
  // [[artifacts]] script as a "file"; deep-linking one lazily generates it for
  // the ref and renders its outputs single-sided. The deep link auto-expands
  // .hydra → artifacts; "screenshots" returns a ready set of mock images.
  { name: 'repository-artifacts', path: '/project/sim-project/repository/main/.hydra/artifacts/screenshots', settleMasonry: true },
  // The same view with its "Show build log" toggle opened: the settled script's
  // persisted log (log_url) loads into an xterm terminal below the images -
  // documents the build-log pane (ANSI colour, button-less overlay scrollbar,
  // Ctrl+C-to-copy). clicks waits out the log fetch the toggle fires; the log
  // sits at the bottom of an inner scroll container, so reveal it for capture.
  { name: 'repository-artifacts-log', path: '/project/sim-project/repository/main/.hydra/artifacts/screenshots', clicks: ['button:has-text("Show build log")'], settleMasonry: true, revealSelector: '.xterm' },
  // The repository browser (a file open) at the small viewports, to document
  // how its tree + content layout reflows. Named repository-* so they tag
  // section::repository; the viewport:: axis is set explicitly for the
  // landscape/tablet sizes (width alone can't tell those apart).
  // The bare repository URL at phone width: below the lg breakpoint the tree
  // is a full-screen file list (the "Repository" header carries the branch +
  // compare pickers), and tapping a file drills into the full-screen file
  // view captured by repository-mobile below.
  { name: 'repository-mobile-list', path: '/project/sim-project/repository', viewport: { width: 390, height: 844 }, viewportOnly: true },
  { name: 'repository-mobile', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 390, height: 844 }, viewportOnly: true },
  // The phone file view's overflow ("hamburger") menu opened: copy contents,
  // view raw, and the view settings - the controls shown inline in the
  // desktop header - collapsed into one top-right menu.
  { name: 'repository-mobile-menu', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 390, height: 844 }, viewportOnly: true, click: 'button[aria-label="File actions"]' },
  // A branch diff drilled into on a phone: enter diff mode from the header
  // (compare → pick branch), then tap a changed file to open its diff
  // full-screen, with the back chevron + file path in the header. Documents
  // the phone drill-down for the compare view.
  { name: 'repository-mobile-diff', path: '/project/sim-project/repository', viewport: { width: 390, height: 844 }, viewportOnly: true, clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("lines.go")'] },
  // Diff mode on a phone *before* picking a file: the changed-files list with
  // the base → head selectors in the header - documenting that the compact
  // selectors fit the narrow header without overflowing.
  { name: 'repository-mobile-diff-list', path: '/project/sim-project/repository', viewport: { width: 390, height: 844 }, viewportOnly: true, clicks: ['button[aria-label="Compare with another branch"]', 'button:has-text("hydra/add-line-numbers")'] },
  { name: 'repository-mobile-landscape', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 844, height: 390 }, viewportTag: 'mobile-landscape', viewportOnly: true },
  { name: 'repository-tablet', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 834, height: 1112 }, viewportTag: 'tablet', viewportOnly: true },
  { name: 'repository-tablet-landscape', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 1112, height: 834 }, viewportTag: 'tablet-landscape', viewportOnly: true },
  // The project settings page, landing on the "All Agents" / Global Defaults
  // tab. Simulation seeds a multi-line pre-spawn script (GetConfig in
  // internal/http/simulation.go), so the capture documents the sandbox
  // policy editor with the ShellEditor's bash highlighting + line-number
  // gutter, the typed text and the highlight layer aligned. It also seeds two
  // inherited-environment variable names, documenting the explicit allow-list
  // editor without exposing any values. The form lives
  // in a viewport-height scroll container, so use a tall viewport to fit the
  // whole page: the pre-spawn + pre-exit editors sit near the bottom, the
  // "Diff Artifacts" editor (the [[artifacts]] scripts) below that, and the
  // "Services" editor (the [[services]], with a live "Running" status badge)
  // below that - so the viewport must be tall enough to reach the very bottom
  // (simulation seeds one of each there).
  { name: 'settings', path: '/project/sim-project/settings', viewport: { width: 1280, height: 2900 } },
  // The User scope tab of the settings page: the user-config
  // ("~/.config/hydra/config.toml") agent form every project inherits.
  // Project-only sections (icon, review, artifacts/tests/services editors,
  // remove project) and the browser preferences (their own tab) are absent.
  { name: 'settings-user', path: '/project/sim-project/settings', click: 'button[role="tab"]:text-is("User")', viewport: { width: 1280, height: 2400 } },
  // The per-agent Claude settings tab, opened by clicking the "Claude" pill in
  // the AgentSelector. Documents the agent-specific ConfigForm and, in
  // particular, the Claude-only "Fullscreen Rendering" toggle that sits between
  // the system pre-prompt and the sandbox policy (off by default - see
  // ResolveFullscreen / claudeRenderingEnv). :text-is matches the pill's exact
  // label, so it can't collide with the "All agents" tab.
  { name: 'settings-claude', path: '/project/sim-project/settings', click: 'button:text-is("Claude")', viewport: { width: 1280, height: 2900 } },
  // The OS-sandbox network egress controls in the new mode form: the egress
  // "mode" dropdown on Hard, the Strict toggle, and the allowed + blocked host
  // editors populated (simulation.go seeds defaults.sandbox.network mode=hard +
  // allowed/blocked hosts). scrollTo pins the "Agent" section so the sandbox
  // policy + network controls fill the frame rather than the page top.
  { name: 'settings-host-filter', path: '/project/sim-project/settings', scrollTo: 'Agent', viewport: { width: 1280, height: 1400 } },
  // The settings page at the small viewports. Below the lg breakpoint the
  // sidebar is collapsed, so a "Settings" header bar (with the show-sidebar
  // toggle) appears above the page; tablet-landscape is wide enough to keep
  // the in-flow sidebar, so it shows the normal page. viewportOnly to focus
  // on the header + top of the form.
  { name: 'settings-mobile', path: '/project/sim-project/settings', viewport: { width: 390, height: 844 }, viewportOnly: true },
  { name: 'settings-mobile-landscape', path: '/project/sim-project/settings', viewport: { width: 844, height: 390 }, viewportTag: 'mobile-landscape', viewportOnly: true },
  { name: 'settings-tablet', path: '/project/sim-project/settings', viewport: { width: 834, height: 1112 }, viewportTag: 'tablet', viewportOnly: true },
  { name: 'settings-tablet-landscape', path: '/project/sim-project/settings', viewport: { width: 1112, height: 834 }, viewportTag: 'tablet-landscape', viewportOnly: true },
  // Same phone width but with edits pending (an entry toggled off), so the
  // "Settings" header bar shows its Save button on the right.
  { name: 'settings-mobile-unsaved', path: '/project/sim-project/settings', viewport: { width: 390, height: 844 }, viewportOnly: true, disableSettingsEntries: true },
  // The same settings page for a project whose emulator-pool service has
  // failed (simulation marks mobile-app's emu-pool failed): the "Services"
  // editor shows a red "Failed" badge + the exit reason, and the project
  // selector in the top bar carries the amber service-failure warning icon
  // next to the project name. Full-page + tall viewport so both the top-bar
  // warning and the failed service card at the bottom are in one shot.
  { name: 'services-warning', path: '/project/mobile-app/settings', viewport: { width: 1280, height: 2900 } },
  // The settings page with both the "Diff Artifacts" and "Services" editors
  // turned OFF, scrolled so those two sections fill the viewport. Toggling
  // each entry's "Enabled" switch off documents the disabled-card styling
  // (dashed border, dimmed body, "Disabled" label/badge) and, because that
  // edits the config, brings up the bottom-pinned FloatingSaveBar - so the
  // floating "Unsaved changes" save affordance is captured too, exactly as it
  // looks from the bottom of a long settings page. scrollTo forces a viewport
  // capture, which includes the fixed save bar.
  {
    name: 'settings-disabled-save',
    path: '/project/sim-project/settings',
    viewport: { width: 1280, height: 1100 },
    disableSettingsEntries: true,
    scrollTo: 'Diff Artifacts',
  },
  // The agent detail header bar showing the user-facing title (e.g. "Add
  // renameable agent titles") in place of the stable ID, the adaptive action
  // toolbar (Merge / Mark as unread / Rename / Kill - shown with labels at this
  // width), and a status dot. Viewport-only so the shot focuses on the bar
  // rather than the terminal/diff below.
  { name: 'agent-title', path: '/project/sim-project/agent/agent-1', viewportOnly: true },
  // The inline rename in progress: clicking the title (it carries an I-beam to
  // signal it's editable) swaps it for an input seeded with the current title
  // (Enter saves via PATCH, Esc cancels). Target the Rename action by its
  // aria-label, which is the bare label "Rename" - the `title` attribute now
  // carries the keyboard hint ("Rename (F2)") on fine-pointer devices
  // (AgentTopBar actionTitle/useFinePointer), so a title="Rename" match no
  // longer works.
  { name: 'agent-rename', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button[aria-label="Rename"]' },
  // The redesigned merge confirmation: clicking Merge opens a rich modal with
  // an icon tile, the from→to branch chip and its +/− diff stats (fetched in
  // the background from the agent's diff). A fixed, viewport-filling overlay,
  // so a viewport capture frames it.
  { name: 'agent-merge-dialog', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button[aria-label="Merge"]' },
  // The redesigned kill confirmation: clicking Kill opens the destructive
  // variant - red icon tile + a warning chip naming how many unmerged files
  // the worktree deletion will discard (count fetched in the background).
  { name: 'agent-kill-dialog', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button[aria-label="Kill"]' },
  // The redesigned merge-conflict panel: agent-3's diff carries the
  // merge_conflict flag (simulation.go GetAgentDiff), so the Changes toolbar
  // shows a red "N conflict" button; clicking it opens the rich panel - red
  // icon tile + title/subtitle, a "Conflicting files" list whose directories are
  // lowlit (the diff's PathName) and a "Resolving locally" CodePane carrying the
  // bash-highlighted resolution script, with Dismiss / Fix-with-agent in
  // the shared dialog-button styling. scrollTo brings the toolbar into view for
  // the click; the panel itself is a fixed, centered overlay.
  { name: 'merge-conflict-dialog', path: '/project/sim-project/agent/agent-3', viewportOnly: true, scrollTo: 'Changes', click: 'button:has-text("conflict")' },
  // The redesigned update-from-base confirmation: agent-2's diff trails its
  // base (behind_count) so the Changes toolbar shows an amber "N behind"
  // button; clicking it opens the rich panel - amber icon tile, a base→branch
  // chip with the behind count, and (because agent-2 also has uncommitted
  // changes) the amber caution note. scrollTo reveals the toolbar for the click.
  { name: 'agent-update-base-dialog', path: '/project/sim-project/agent/agent-2', viewportOnly: true, scrollTo: 'Changes', click: 'button:has-text("behind")' },
  // The agent-detail prompt block rendering the upload paths a prompt carries
  // as attachment chips instead of raw links: three image thumbnails (served a
  // fixed stub PNG) and one non-image file shown with a generic icon, the
  // descriptive prompt text above them. Clicking an image opens the same
  // fullscreen lightbox the spawn form uses (documented by spawn-image-lightbox).
  // Viewport-only to focus on the header + prompt block. agent-2's seeded
  // prompt (simulation.go simAgent2Prompt) carries the paths; it's already in
  // ListAgents so the detail page renders from the store (the one-shot getAgent
  // never resolves in simulation); stubUpload serves the thumbnails.
  { name: 'agent-prompt-attachments', path: '/project/sim-project/agent/agent-2', viewportOnly: true, stubUpload: 'web/public/android-chrome-512x512.png' },
  // (The security-gate approval cards are documented as the harness-driven
  // agent-approvals-* shots above - the simulated agent no longer parks a live
  // approval, so the cards don't leak onto every simulated page.)
  { name: 'nested-folders', path: '/project/sim-project/agent/agent-3', scrollTo: 'Changes' },
  // The diff viewer's settings popup, opened from the gear in the sticky
  // "Changes" toolbar: the file-list view modes, the diff options (side-by-
  // side, ignore whitespace, one-file-at-a-time) and the image-diff comparison
  // modes. The nav's settings icon
  // is a <Link> (an <a>). Keyed on the popover's aria-label rather than its icon:
  // SettingsPopover renders a Settings2 glyph, and icon classes get renamed
  // the diff gear. scrollTo pins the toolbar to the top; viewport capture (the
  // popup is absolutely positioned just below the gear).
  {
    name: 'diff-settings',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1000 },
    click: 'button[aria-label="File options"]',
  },
  // The sticky file header: each file's header now pins beneath the sticky
  // "Changes" toolbar while that file's diff scrolls under it - the same
  // stacked-sticky treatment the artifacts/tests headers use. We scroll
  // agent-1's diff so the web/src/components/AgentDetail.tsx file's header is
  // stuck under the toolbar (its body scrolled partway under it), with the
  // file-list sidebar pinned at the same Y on the left. A taller viewport so
  // the toolbar, the gap below it, the pinned header and several diff rows
  // are all in frame.
  {
    name: 'diff-sticky-file-header',
    path: '/project/sim-project/agent/agent-1',
    viewport: { width: 1280, height: 1000 },
    stickFile: 'web/src/components/AgentDetail.tsx',
  },
  // A read-only archived (killed/merged) agent page: no live terminal/diff,
  // just the prompt and a (not-yet-wired) Resume affordance. The grayed
  // "Archived" sidebar section itself is already visible in the `home` shot.
  { name: 'archived-agent', path: '/project/sim-project/agent/archived-1' },
  // agent-1's diff carries simulated "screenshots" artifacts (mixed phone +
  // desktop shapes). Scroll to the "Changes" header - the artifacts panel
  // renders directly below it - and use a taller viewport so the wrapped
  // before/after cards fit in one capture. Meta: a screenshot of the diff
  // page showing artifact before/after screenshots.
  //
  // The diff viewer offers four image-diff comparison modes (a setting in the
  // diff viewer; see web/src/components/ArtifactsPanel.tsx ImageDiffView). We
  // capture the artifacts panel once per mode so each option is documented:
  //   side-by-side - before and after shown next to each other ('artifacts')
  //   ab           - before/after stacked, click to flip; a "Highlight" tab
  //                  paints the changed pixels magenta (the app's default mode)
  //   slider       - draggable divider with a hard cut between before/after
  //   onion        - before/after blended via an opacity slider
  // Each sets showArtifacts so the "screenshots" card is expanded and its
  // before/after masonry is actually visible (the card defaults to collapsed).
  // The collapsed panel itself is documented by 'artifacts-collapsed' below.
  {
    name: 'artifacts',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    showArtifacts: true,
  },
  // Clicking a before/after artifact image opens it in the same Slack-style
  // fullscreen lightbox the spawn box uses (blurred backdrop, the filename +
  // pixel dimensions in the caption) rather than a new browser tab. showArtifacts
  // expands the "screenshots" card and decodes its tiles; openArtifactImage then
  // clicks the first image to open the overlay. Side-by-side mode so the clicked
  // tile is a single plain image (left-click), and a viewport capture (the
  // lightbox is a fixed overlay covering the screen).
  {
    name: 'artifact-image-lightbox',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    showArtifacts: true,
    openArtifactImage: true,
  },
  // The lightbox is diff-aware: opened from a tile, it shows the before/after
  // comparator fullscreen with a mode selector. These two switch it to the AB
  // (Before · After toggle) and onion-skin modes inside the lightbox, documenting
  // that every diff mode works there - not just a static image.
  {
    name: 'artifact-lightbox-ab',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    showArtifacts: true,
    openArtifactImage: true,
    lightboxMode: 'Before · After',
  },
  {
    name: 'artifact-lightbox-onion',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    showArtifacts: true,
    openArtifactImage: true,
    lightboxMode: 'Onion skin',
  },
  // The lightbox magnified: a screenshot too small to read at fit can be zoomed
  // (scroll-wheel) and panned, with a bottom-right minimap + "Reset view (N×)"
  // button. lightboxZoom wheels in after switching to the single-image A/B view.
  {
    name: 'artifact-lightbox-zoom',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    showArtifacts: true,
    openArtifactImage: true,
    lightboxMode: 'Before · After',
    lightboxZoom: true,
  },
  // The collapsed artifacts panel: each set is a single header row ("N changed",
  // a spinner while generating, etc.) until clicked open - the default, opt-in
  // state. Documents the at-a-glance overview before any card is expanded.
  {
    name: 'artifacts-collapsed',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
  },
  {
    name: 'artifacts-ab',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'ab',
    showArtifacts: true,
  },
  // The AB mode with the "Highlight" overlay ticked on every changed-image
  // tile: each tile's pixel-diff (DiffCanvas) paints the differing pixels
  // magenta on top of the shown side, so the exact changed regions are
  // marked while flipping Before↔After. Like artifacts-ab but with Highlight
  // enabled - documents the overlay (and its pixel-for-pixel alignment with
  // the base image).
  {
    name: 'artifacts-highlight',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'ab',
    showArtifacts: true,
    highlightArtifacts: true,
  },
  {
    name: 'artifacts-slider',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'slider',
    showArtifacts: true,
  },
  {
    name: 'artifacts-onion',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'onion',
    showArtifacts: true,
  },
  // The artifacts tag filter in use. agent-1's "screenshots" set tags each
  // shot by theme + viewport (scoped labels) plus a free-form "new" (see
  // simReadyChangedSet in internal/http/simulation.go), so the header shows
  // the theme/viewport filters and each file shows tag badges. We hide the
  // dark theme value so the capture documents an ACTIVE filter: the dark-only
  // shots drop out and the header count reads "shown/total changed".
  {
    name: 'artifacts-tags',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    tagFilter: { scoped: { theme: ['dark'] } },
    showArtifacts: true,
  },
  // The tag-filter dropdown opened, documenting the menu itself: the fixed
  // "all" (left) / "clear" (right) header, the value checkboxes (all on by
  // default), and the "shift-click to isolate" hint. Left unfiltered so every
  // box reads checked. Opens the "theme" filter and captures the viewport.
  {
    name: 'artifacts-filter',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    openFilter: 'theme',
    showArtifacts: true,
  },
  // The "changes" filter dropdown opened to show the "% changed" threshold
  // slider at its foot: it sets how much of an image's pixels (or a video's
  // frames) must differ before a "modified" file counts as changed; below it,
  // a file is treated as identical. Seeded to 10% (so the trigger reads its
  // active style and the slider sits mid-track) - at that gate the near-
  // identical home shots (3% changed, see simReadyChangedSet ChangeRatio) fold
  // into the "unchanged" count while the larger login/profile/webm diffs stay
  // "modified", which the per-value counts in the menu document.
  {
    name: 'artifacts-threshold',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    tagFilter: { changeThreshold: 10 },
    openFilter: 'changes',
    showArtifacts: true,
  },
  // The artifacts panel's info (i) tooltip, opened - documents what artifacts
  // are, the script contract, the progress marker, and the tags/filter rules
  // (the tooltip's last paragraph). Hovered open and captured against the
  // diff page so it reads in context.
  {
    name: 'artifact-info',
    path: '/project/sim-project/agent/agent-1',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    artifactInfo: true,
  },
  // Every render state of the artifacts panel in one shot. agent-1's
  // simulated response (internal/http/simulation.go) carries four sets -
  // changed, generating (with a live progress line), error, and no-visual-
  // changes - each in the same card. A taller viewport fits all four so the
  // states document side by side. Documents that switching states never
  // changes the card shell and refresh stays reachable in every state.
  {
    name: 'artifact-states',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1800 },
    imageDiffMode: 'side-by-side',
  },
  // Search narrows like the tag filter: a query that matches nothing leaves
  // every card in place (each header count reflecting the narrowing, e.g.
  // "0/N changed") rather than removing non-matching cards or auto-expanding
  // them. Documents that the search box and the tag filter behave alike.
  {
    name: 'artifact-search-empty',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 900 },
    imageDiffMode: 'side-by-side',
    searchArtifacts: 'zzzznomatch',
  },
  // The in-flight artifact card expanded, documenting the per-file
  // ::hydra:artifact:: streaming: the tiles that have finished so far render at
  // the top (they trickle in live over the WS, see HandleArtifactsWS), above
  // the two sides' (Before / After) live generation logs - each a scrollable,
  // monospaced stdout+stderr stream (stderr in red), with the header showing
  // both sides' progress joined by "·" and elapsed time. agent-1's
  // "components" set is the generating one (internal/http/simulation.go).
  {
    name: 'artifact-log',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1400 },
    imageDiffMode: 'side-by-side',
    expandArtifact: 'components',
  },
  // A wholly-failed artifact card expanded: both sides failed, so instead of a
  // separate red error box the card surfaces the build log as two red-bordered
  // terminals (the script's stderr is the failure detail). agent-1's
  // "storybook" set is the error one (internal/http/simulation.go); the build
  // log auto-opens on failure, so no extra click is needed.
  {
    name: 'artifact-failure',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1280 },
    imageDiffMode: 'side-by-side',
    expandArtifact: 'storybook',
  },
  // A partially-failed card expanded: the before (left) side died but the after
  // side rendered, so the card stays "ready" - the before terminal is
  // red-bordered while the after terminal and the surviving side's images still
  // show below. agent-1's "dashboard" set is the partial-failure one.
  {
    name: 'artifact-partial-failure',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 1400 },
    imageDiffMode: 'side-by-side',
    expandArtifact: 'dashboard',
  },
  // The split regenerate button's dropdown open, documenting per-side
  // regeneration (regenerate both / before only / after only). Opened on the
  // always-present "screenshots" card's header.
  {
    name: 'artifact-regen-menu',
    path: '/project/sim-project/agent/agent-1',
    scrollTo: 'Changes',
    viewport: { width: 1280, height: 900 },
    imageDiffMode: 'side-by-side',
    click: 'div.rounded-lg:has-text("screenshots") button[aria-label="Regenerate options"]',
  },
  // The video diff viewer (VideoDiffView) shown directly: agent-1's
  // "screenshots" set carries a .webm artifact (loader-animation.webm) the
  // panel routes to the video viewer instead of the image one. It otherwise
  // only renders inside the collapsed screenshots card, so these two shots
  // expand it and pin the .webm row to the top. The before/after pair is
  // seeked to a mid-clip frame (paused) so the progress bars differ. Two
  // shots document the two most distinct video modes:
  //   side-by-side   - the Before / After clips next to each other + transport
  //   ab + Highlight - the per-frame pixel diff (changed pixels painted magenta),
  //                    now a "Highlight" tab inside the Before/After mode
  {
    name: 'artifact-video',
    path: '/project/sim-project/agent/agent-1',
    viewport: { width: 1280, height: 1000 },
    imageDiffMode: 'side-by-side',
    videoDiff: { seek: VIDEO_SEEK },
  },
  {
    name: 'artifact-video-diff',
    path: '/project/sim-project/agent/agent-1',
    viewport: { width: 1280, height: 1000 },
    imageDiffMode: 'ab',
    videoDiff: { seek: VIDEO_SEEK, highlight: true },
  },
  // ── Mobile / small-screen layout ───────────────────────────────────────
  // The same UI captured at phone width (390×844) to document the responsive
  // work: the sidebar collapses into a hamburger-toggled off-canvas drawer,
  // the header/metadata rows wrap, padding tightens, and the diff drops its
  // file-list sidebar for a full-width unified diff. The width (<700) makes
  // each of these tag itself viewport::mobile (see the sidecar block below),
  // so a reviewer can filter the panel down to just the small-screen shots.
  //
  // The project home at phone width: the full-page spawn form fills the
  // screen, the top bar is gone, and the sidebar is collapsed by default -
  // so only the small floating "show sidebar" button sits top-left.
  { name: 'mobile-home', path: '/project/sim-project/', viewport: { width: 390, height: 844 } },
  // The sidebar opened: clicking the floating reveal button slides the
  // sidebar in over a dimmed backdrop. It now carries the whole app chrome -
  // its header has the project selector + collapse button, and its footer the
  // Settings link + usage. Viewport capture since the drawer is a fixed overlay.
  {
    name: 'mobile-menu',
    path: '/project/sim-project/',
    viewport: { width: 390, height: 844 },
    viewportOnly: true,
    click: 'button[aria-label="Show sidebar"]',
  },
  // An agent detail page at phone width: the title + action buttons wrap, the
  // metadata row wraps, and the prompt/terminal stack full-width. Viewport-
  // only to focus on the header region rather than the long page below.
  { name: 'mobile-agent', path: '/project/sim-project/agent/agent-1', viewport: { width: 390, height: 844 }, viewportOnly: true },
  // A diff at phone width: the file-list sidebar is hidden so the unified
  // diff takes the full width and wraps long lines. agent-3's nested-folder
  // diff scrolled to the Changes section.
  { name: 'mobile-diff', path: '/project/sim-project/agent/agent-3', viewport: { width: 390, height: 844 }, scrollTo: 'Changes' },
  // The agent page's top bar (shown while the sidebar is collapsed): the
  // show-sidebar toggle, the agent name, and the adaptive action toolbar. At
  // phone width the title takes priority, so the actions fold into the overflow
  // "⋯" menu rather than truncating the name - opened here to show the remaining
  // actions (Mark as unread / Rename / Kill). Shortcut hints are hidden on the
  // touch viewport (no keyboard).
  {
    name: 'mobile-agent-menu',
    path: '/project/sim-project/agent/agent-1',
    viewport: { width: 390, height: 844 },
    viewportOnly: true,
    coarsePointer: true,
    click: 'button[aria-label="More actions"]',
  },

  // ── Mobile landscape (844×390) ──────────────────────────────────────────
  // A phone held sideways: very short, so vertical space is precious. With
  // the top bar gone and the sidebar collapsed by default, the content gets
  // the whole height; the floating reveal button is the only chrome.
  { name: 'mobile-landscape-home', path: '/project/sim-project/agent/agent-1', viewport: { width: 844, height: 390 }, viewportTag: 'mobile-landscape', viewportOnly: true },

  // ── Tablet portrait (834×1112) ──────────────────────────────────────────
  // A tablet upright: below the lg breakpoint, so the sidebar is an overlay
  // (collapsed by default) and the content spans the full width - no more
  // cramped permanent two-column split.
  { name: 'tablet-home', path: '/project/sim-project/agent/agent-1', viewport: { width: 834, height: 1112 }, viewportTag: 'tablet', viewportOnly: true },

  // ── Tablet landscape (1112×834) ─────────────────────────────────────────
  // A tablet on its side: at/above the lg breakpoint, so the sidebar is the
  // usual persistent in-flow column - this is the clearest look at the new
  // chrome (selector + collapse button in the sidebar header, Settings +
  // usage in its footer, no top bar).
  { name: 'tablet-landscape-home', path: '/project/sim-project/agent/agent-1', viewport: { width: 1112, height: 834 }, viewportTag: 'tablet-landscape', viewportOnly: true },
  // The same width with the sidebar collapsed via its header button: the
  // column is gone, the content reclaims the full width, and the floating
  // reveal button sits top-left.
  {
    name: 'tablet-landscape-collapsed',
    path: '/project/sim-project/agent/agent-1',
    viewport: { width: 1112, height: 834 },
    viewportTag: 'tablet-landscape',
    viewportOnly: true,
    click: 'button[aria-label="Hide sidebar"]',
  },

  // ── Desktop: the moved chrome ───────────────────────────────────────────
  // The Settings page now hosts the Appearance (light/dark/system) control
  // that used to live in the top bar. It lives on the Browser scope tab (a
  // browser-local preference), so switch tabs before capturing the header
  // region that documents it - this shot doubles as the Browser tab's
  // documentation (theme / terminal / notifications, no Save button).
  { name: 'settings-appearance', path: '/project/sim-project/settings', click: 'button[role="tab"]:text-is("Browser")', viewport: { width: 1280, height: 900 }, viewportOnly: true },
  // The desktop layout with the sidebar collapsed (Ctrl+. / the header
  // button): full-width content + the floating reveal button.
  { name: 'desktop-collapsed', path: '/project/sim-project/agent/agent-1', click: 'button[aria-label="Hide sidebar"]', viewportOnly: true },
  // The artifacts panel at phone width: the masonry clamps to a single column
  // (no column is allowed below BASE_MIN_COL_PX), so every tile's aspect-ratio
  // span collapses and the width-driven before/after tiles stack full-width -
  // the panel stays usable on a narrow screen. showArtifacts expands the card so
  // the images (not just the collapsed header) are captured.
  { name: 'mobile-artifacts', path: '/project/sim-project/agent/agent-1', viewport: { width: 390, height: 844 }, scrollTo: 'Changes', imageDiffMode: 'ab', showArtifacts: true },
]

// shotSelectors flattens the list into the (page, selector) pairs a preflight
// needs: everything a shot will try to click or hover. Kept here so the spec
// never has to know the shape of an entry.
export function shotSelectors(): { name: string; path: string; selectors: string[]; viewport?: { width: number; height: number } }[] {
  const out: { name: string; path: string; selectors: string[]; viewport?: { width: number; height: number } }[] = []
  for (const pg of pages) {
    const p = pg as { name: string; path: string; click?: string; clicks?: string[]; hover?: string; viewport?: { width: number; height: number } }
    const selectors = [p.click, ...(p.clicks ?? []), p.hover].filter((s): s is string => !!s)
    // The viewport rides along because it CHANGES WHICH CONTROLS EXIST: the
    // mobile/tablet shots click a hamburger that the desktop layout doesn't
    // render at all. A preflight that checked them at the default width would
    // report those as broken every run, and an alarm that always cries wolf is
    // worse than no alarm.
    if (selectors.length) out.push({ name: p.name, path: p.path, selectors, viewport: p.viewport })
  }
  return out
}
