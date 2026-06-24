/// <reference types="node" />
//
// Diff-viewer artifact generator for Hydra's own web UI.
//
// The diff viewer (PLAN.md #17) runs a per-project "[[artifacts]]" command
// against both sides of a comparison and surfaces the rendered images that
// differ. This script builds the checkout's frontend + a hydra binary, boots
// the server in --simulation mode (mock data, no daemon/project needed), and
// screenshots the home page with a headless Chromium.
//
// Contract (set by internal/artifacts):
//   HYDRA_ARTIFACT_OUTPUT  dir to write image files into (we write home.png)
//   HYDRA_ARTIFACT_SOURCE  the checkout dir (repo root); cwd when run via sh -c
//   HYDRA_ARTIFACT_REF     the resolved ref being rendered (informational)
//
// Tags: alongside each <name>.png we write a <name>.png.meta JSON sidecar
// ({"tags": [...]}) that the diff viewer surfaces as labels + filters (see
// internal/artifacts readTagsSidecar). Every shot is tagged with its theme,
// viewport, and UI section as scoped "category::value" labels.
//
// Run with: bun take-screenshots.ts  (from scripts/screenshots/)
//
// Progress: each major step emits a one-line "::hydra:progress::" marker (build
// phases and, during capture, "<name>.png <n>/<total>"). Hydra strips the prefix
// and surfaces the rest as the live progress header — and, once it sees a marker,
// stops treating ordinary stdout as progress, so the noisy subprocess output
// (bun install, vite build) below can't hijack the header. Keep markers short and
// human-readable; everything still lands in the full build log.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import ffmpegStatic from 'ffmpeg-static'

// A fixed instant the browser clock is pinned to for every capture, so any
// duration the UI derives from "now" — an agent's "spawned X ago", the artifacts
// panel's elapsed timer — renders deterministically and doesn't make two
// otherwise-identical renders diff (see the nondeterminism note below). It MUST
// match the simulation server's fixed clock (internal/http/simulation.go simNow),
// which dates its mock timestamps relative to this same instant, so e.g. an
// artifact "started 8s ago" reliably reads "8s" rather than 8s/9s by sub-second
// luck.
const SIM_NOW = new Date('2025-01-01T12:00:00Z')

// A markdown-rich spawn-prompt draft seeded into the spawn box for the
// inline-markdown demo. Long enough to wrap in the box (so the wrapped inline-
// code chip is captured), and includes a literal "$ …" run that must stay
// ordinary code in a prompt (the $-command override is activity-only).
const MARKDOWN_DEMO_PROMPT =
  "Add **simple inline-markdown** rendering so prompts and the live-activity line aren't flat text.\n\n" +
  'Highlight `inline code`, *italic* and **bold** as you type. A long command in backticks like `go test ./internal/heads/... -run TestResumeLazy -count=1 -race -v` wraps across lines, each fragment keeping its own rounded background, and a line that contains `code` stays exactly as tall as a plain one.\n\n' +
  'Note: a literal `$ run-this-command --now` in the prompt is just code, not a command — that override is activity-only.\n\n' +
  'A fenced block renders as its own code chip:\n```ts\nconst seg = parseInline(text)\nrenderMarkdown(seg) // code/bold/italic\n```'

const OUT = required('HYDRA_ARTIFACT_OUTPUT')
// HYDRA_ARTIFACT_SOURCE is the checkout root. Fall back to the repo root two
// levels up from this script so it also works when run by hand.
const SRC = process.env.HYDRA_ARTIFACT_SOURCE || join(import.meta.dir, '..', '..')
const REF = process.env.HYDRA_ARTIFACT_REF || '(unknown)'

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`missing required env ${name}`)
    process.exit(2)
  }
  return v
}

// progress emits a Hydra progress marker. Hydra strips the "::hydra:progress::"
// prefix and shows the rest as the live progress header (see the file header).
function progress(msg: string) {
  console.log(`::hydra:progress:: ${msg}`)
}

// sectionFor maps a page name to its UI area, emitted as a scoped "section::"
// tag so the diff viewer can filter shots by the part of the app they cover
// (repository browser, artifacts panel, …). Grouping by name prefix keeps the
// page list (the source of truth) the only place a new shot must be declared.
function sectionFor(name: string): string {
  if (name.startsWith('repository-diff')) return 'repository-diff'
  if (name.startsWith('repository')) return 'repository'
  if (name.startsWith('artifact')) return 'artifacts'
  if (name.startsWith('archived')) return 'archived'
  if (name.startsWith('agent-')) return 'agent'
  if (name.startsWith('spawn')) return 'spawn'
  if (name.startsWith('settings') || name === 'services-warning') return 'settings'
  if (name === 'nested-folders') return 'diff'
  return 'overview'
}

// run executes a command, inheriting stdio, and throws on a non-zero exit.
function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>) {
  console.log(`+ (${cwd}) ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status ?? res.signal}`)
  }
}

// freePort asks the OS for an unused TCP port (closed before we return it).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as import('node:net').AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server did not become ready at ${url} within ${timeoutMs}ms`)
}

// settle waits for the page to be visually stable before a capture, without a
// fixed sleep: web fonts finished loading, plus two animation frames so any
// pending layout/paint (and React commit) has flushed. With CSS animations and
// transitions disabled (see the injected stylesheet), this is deterministic and
// far quicker than a blanket waitForTimeout. Note the page freezes short
// setTimeouts but leaves requestAnimationFrame intact, so the rAF wait works.
async function settle(page: import('playwright').Page) {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  })
}

console.log(`Rendering Hydra UI for ref ${REF} from ${SRC}`)

// 1. Build the frontend. The Go binary embeds web/dist (web/embed.go), so this
//    must happen before the go build. We invoke vite + the routes-regex
//    generator directly rather than `bun run build` to skip the tsc typecheck
//    (a type error in some checkout shouldn't block a screenshot) and the
//    openapi/router codegen (their outputs are committed).
const webDir = join(SRC, 'web')
progress('building frontend')
run('bun', ['install'], webDir)
run('bun', ['x', 'vite', 'build'], webDir)
run('bun', ['scripts/generate-routes-regex.ts'], webDir)

// 2. Build the hydra binary from the checkout into a throwaway dir.
progress('building hydra binary')
const binDir = mkdtempSync(join(tmpdir(), 'hydra-shot-'))
const bin = join(binDir, 'hydra')
run('go', ['build', '-o', bin, './'], SRC)
if (!existsSync(bin)) throw new Error(`go build produced no binary at ${bin}`)

// 3. Boot the simulation server on a free port.
const port = await freePort()
const addr = `127.0.0.1:${port}`
const base = `http://${addr}`
console.log(`+ ${bin} server --simulation (HYDRA_API_ADDR=${addr})`)
const server: ChildProcess = spawn(bin, ['server', '--simulation'], {
  cwd: SRC,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, HYDRA_API_ADDR: addr },
})

try {
  progress('booting simulation server')
  await waitForServer(base + '/', 30_000)
  progress('capturing screenshots')

  // 4. Screenshot the pages. The home page ("/") shows the full app shell:
  //    header, project dropdown, agent sidebar (populated with mock data) and
  //    the main content pane. The "nested-folders" page opens a simulated
  //    agent (agent-3) whose diff spans deeply nested paths, so the captured
  //    diff tree shows VS Code-style compacted folders (one/two/three on a
  //    single row) — see internal/http/simulation.go GetAgentDiff(agent-3).
  //
  //    The diff viewer compares versions by hashing the output bytes and only
  //    surfaces files that differ, so the render MUST be byte-reproducible —
  //    otherwise unchanged UI would always look "modified". Three sources of
  //    nondeterminism are neutralized:
  //      * Chromium font anti-aliasing: pinned with the flags below
  //        (no GPU, no LCD/subpixel text, fixed hinting + color profile).
  //      * App-level animation: an init script freezes Math.random (the spawn
  //        form shuffles its placeholder phrases) and no-ops the short timers
  //        that drive the typewriter placeholder, and a stylesheet disables CSS
  //        animations/transitions and the text caret.
  //      * Wall-clock-derived labels (elapsed timers, "spawned X ago"): the
  //        browser clock is pinned to a fixed instant (ctx.clock.setFixedTime,
  //        below) matching the simulation server's fixed clock, so a duration
  //        shown in seconds reads identically in both renders.
  const flags = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-skia-runtime-opts',
    '--disable-lcd-text',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
    '--disable-partial-raster',
    '--hide-scrollbars',
    '--disable-features=PaintHolding',
  ]
  const browser = await chromium.launch({ headless: true, args: flags })
  try {
    // `scrollTo` names a section <h2> to pin to the top of its scroll container
    // before a non-fullPage capture — used when the interesting content sits
    // below the fold. agent-3's diff tree is below the terminal, so we scroll
    // the "Changes" section to the top and capture just the viewport there
    // instead of the whole (mostly-terminal) page.
    const pages: {
      name: string
      path: string
      scrollTo?: string
      viewport?: { width: number; height: number }
      // CSS selector clicked once (after load, before capture) — used to open a
      // popover such as the repository branch selector so the screenshot
      // documents it.
      click?: string
      // CSS selectors clicked in sequence (each followed by a settle), then a
      // networkidle wait so any fetch a click kicks off has rendered before the
      // capture. Used by the branch-compare diff shots, where pressing the diff
      // button enters diff mode (and fetches the diff) and an optional second
      // click opens the popped-out compare branch selector.
      clicks?: string[]
      // Glob of a request to hold open (never fulfilled) so the page is captured
      // in its in-flight loading state — e.g. holding the repo file-contents
      // request so the loading spinner shows. With a request pending, networkidle
      // never fires, so the goto waits for the DOM instead and then for the
      // spinner to appear.
      holdRequest?: string
      // Seeds the diff viewer's image-diff comparison mode ('hydra-diff-image-mode')
      // before the app boots, so the artifacts panel renders before/after pairs in
      // the chosen mode. Only meaningful on the artifacts (agent-1) page.
      imageDiffMode?: 'side-by-side' | 'ab' | 'difference' | 'slider' | 'onion'
      // Seeds the repository diff's one-file-at-a-time preference
      // ('hydra-repo-diff-single-file') before boot. Omit for the default
      // (one file at a time); set false to capture the all-files-stacked view.
      repoDiffSingleFile?: boolean
      // Expands the named artifact card (clicks its header) after load — used to
      // document the in-flight card's live, scrollable generation log.
      expandArtifact?: string
      // Attaches the given checkout-relative images to the spawn form's hidden
      // file input (each fed in named "image.png", so the form renumbers them
      // image1.png, image2.png …) and then opens the lightbox by clicking the
      // first attachment chip — documents the fullscreen image viewer and the
      // numbered-paste naming. Captures the viewport (the lightbox is a fixed
      // overlay), and the upload request is stubbed so the chips settle instantly.
      attachImages?: string[]
      // Captures only the viewport (not the full page), unscrolled, so the shot
      // focuses on a page's header region — e.g. the agent detail title bar —
      // rather than the long content (terminal, diff) below it.
      viewportOnly?: boolean
      // Stubs the upload-serving endpoint (GET /uploads/.../blob) with this
      // checkout-relative PNG, so a prompt block that references upload images
      // renders its attachment-chip thumbnails (and lightbox) from a fixed,
      // deterministic image — no real uploads dir needed. After load, waits for
      // the chips to render. Used by the agent-prompt-attachments shot.
      stubUpload?: string
      // Seeds an unsent spawn-prompt draft (both the compact + full layout keys)
      // before the app boots, so the spawn box renders pre-filled — used to
      // document the live inline-markdown highlighting (and its line-wrapping)
      // in the textarea overlay without driving keystrokes.
      seedPrompt?: string
      // Screenshot-only: enlarge BOTH spawn boxes (the compact sidebar box and
      // the full-page main box) so a seeded markdown draft reads in full rather
      // than scrolled, and widen the sidebar so the compact box has room. Purely
      // a capture-time override: box heights are set via injected JS after the
      // page settles, and the sidebar width is seeded into localStorage before
      // boot. The app's real default box/sidebar sizes are unchanged. Pairs with
      // seedPrompt.
      tallSpawn?: boolean
      // Seeds the artifact tag filter (localStorage key built from project+agent)
      // before the app boots, so the artifacts panel renders with a filter applied.
      // Each array lists a scope's HIDDEN values (e.g. { theme: ['dark'] } drops
      // the dark shots) — documents the header tag filter actively in use plus the
      // per-file tag badges. Only meaningful on the artifacts (agent-1) page.
      tagFilter?: { scoped?: Record<string, string[]>; free?: string[] }
      // Opens a tag-filter dropdown by its button label (e.g. 'theme'), so the
      // capture documents the menu itself: the all/clear header and the value
      // checkboxes (all on by default). Only meaningful on the artifacts page.
      openFilter?: string
      // Hovers the artifacts panel's info (i) icon so its tooltip opens, after
      // scrolling the "Artifacts" heading to mid-viewport to give the upward-
      // opening tooltip room. Captures the viewport (the tooltip is a fixed
      // portal). Only meaningful on the artifacts (agent-1) page.
      artifactInfo?: boolean
      // Expands the "screenshots" card, seeks its loader-animation.webm pair to
      // the given time (paused), and pins that row to the top — so the capture
      // shows the video diff viewer (VideoDiffView) directly rather than buried
      // in a collapsed "N changed" card. Captures the viewport. The seek lands a
      // mid-clip frame so the before/after progress bars differ; the page's
      // play() no-op keeps the pair paused so the frame is byte-stable. Only
      // meaningful on the artifacts (agent-1) page, paired with imageDiffMode.
      videoDiff?: { seek: number }
      // Settings only: turn OFF the "Enabled" switch on the seeded [[artifacts]]
      // and [[services]] entries (the EnabledToggle in web/.../SettingsComponents).
      // Flipping each to disabled both mutes/labels its card "Disabled" AND marks
      // the config dirty, so the bottom-pinned FloatingSaveBar appears — one shot
      // documenting the disabled-entry styling and the floating save affordance.
      // Pair with scrollTo: 'Diff Artifacts' so the two editors fill the viewport.
      disableSettingsEntries?: boolean
    }[] = [
      { name: 'home', path: '/' },
      // The unread-changes indicator: the agent sidebar shows an amber dot on the
      // right of agents that went running→waiting/finished while you were away
      // (agent-2 in the simulation), and the project dropdown — opened here —
      // shows a per-project unread count badge, with a dot on the folder button
      // when other projects have updates waiting (see simulation.go ListProjects /
      // ListAgents and AgentSidebarItem).
      { name: 'unread-indicator', path: '/', click: 'button[aria-label="Select project"]' },
      // The spawn form's image lightbox: two images attached to the prompt, the
      // first opened in the Slack-style fullscreen viewer (blurred backdrop,
      // prev/next arrows, "1 / 2" counter). Also shows the numbered-paste naming
      // (image1.png) on the chips behind. Rendered on the full-page spawn form.
      { name: 'spawn-image-lightbox', path: '/project/sim-project/', attachImages: ['web/public/android-chrome-512x512.png', 'web/public/apple-touch-icon.png'] },
      // The inline-markdown rendering (the markdown-pass feature). The spawn box
      // is seeded with a markdown draft so the textarea overlay shows live
      // highlighting — `code`, *italic*, **bold**, and a long inline-code
      // reference wrapping across lines — and the sidebar shows the rendered
      // live-activity lines: agent-md's markdown activity and agent-3's
      // "$ …"-command activity (rendered wholly as code, overriding markdown).
      // Full-page so both the box and the sidebar activity land in one shot.
      // tallSpawn enlarges both spawn boxes (capture-only) so the whole seeded
      // draft, fenced code block included, is visible without scrolling.
      { name: 'spawn-markdown', path: '/project/sim-project/', seedPrompt: MARKDOWN_DEMO_PROMPT, tallSpawn: true },
      // The agent-detail prompt block rendering the same markdown: code/bold/
      // italic, an inline-code span that wraps, the tightened gap under the
      // metadata row, and the soft bottom fade as the tall prompt scrolls out of
      // view. Viewport-only to focus on the header + prompt (agent-md's seeded
      // prompt overflows the block's max height, so the fade is visible).
      { name: 'agent-markdown', path: '/project/sim-project/agent/agent-md', viewportOnly: true },
      // The repository view: a GitHub-style browser with a file/folder tree on
      // the left and the picked file rendered on the right. Simulation mode
      // serves a small mock repo (see internal/http/simulation.go) and opens
      // README.md by default, so the capture shows rendered markdown beside the
      // tree. Full-page; the layout fills the viewport with internal scroll.
      { name: 'repository', path: '/project/sim-project/repository' },
      // The repository view's loading state: while a file's contents are being
      // fetched the main pane shows a centered spinner (not the previously shown
      // file), so switching files never flashes stale content. We hold the
      // file-contents request open so the capture lands mid-load — the tree
      // populated on the left, the spinner on the right. (The file request only
      // fires once branches + tree have loaded, so holding it implies both are
      // already rendered.)
      { name: 'repository-loading', path: '/project/sim-project/repository', holdRequest: '**/repository/file*' },
      // The repository view showing a source file: a deep-linked URL
      // (/repository/<ref>/<path>) renders the file with line numbers and the
      // tree auto-expanded down to it (folders are otherwise collapsed). Demos
      // PLAN.md #41a (line numbers) + #41d (wrapping) + #41f (URL routing).
      { name: 'repository-code', path: '/project/sim-project/repository/main/internal/server/server.go' },
      // The "raw" file view: the file header's Raw button (and the image
      // preview's copy/raw controls) open the unrendered blob in a new tab,
      // served by the /repository/.../blob endpoint and rendered by the browser
      // as plain text — GitHub's "raw" page. We navigate straight to that blob
      // URL to document where the Raw button lands. Theme doesn't affect the
      // browser's plain-text rendering, so the light/dark shots match.
      { name: 'repository-raw', path: '/repository/projects/sim-project/blob?path=internal/server/server.go&ref=main' },
      // The branch selector opened over the source-file view: Hydra agent
      // branches (hydra/*) are listed first (PLAN.md #41b).
      {
        name: 'repository-branches',
        path: '/project/sim-project/repository/main/internal/server/server.go',
        click: 'button[title="Switch branch"]',
      },
      // The branch-compare diff view: the diff button (the GitCompare icon beside
      // the branch selector) opens the branch dropdown; picking a branch diffs it
      // against the browsed ref. The sidebar header becomes "base → head" and the
      // main pane shows the diff (reusing the agent diff's FileDiff/FileRow), with
      // per-file line counts and added/removed/renamed change-type tags.
      // Simulation serves a small mock diff with one of each change type (see
      // GetRepositoryDiff in internal/http/simulation.go). The default is one file
      // at a time — the main pane shows only the file selected in the left list.
      {
        name: 'repository-diff',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")'],
      },
      // The same diff with the all-files-stacked view (a stored preference,
      // toggled in the diff settings popup): every changed file's diff is shown
      // at once rather than one at a time.
      {
        name: 'repository-diff-all',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")'],
        repoDiffSingleFile: false,
      },
      // One file at a time, selecting each change type from the left list (the
      // third click). heads.go is a full-context ("expanded") file, so its diff
      // shows surrounding context collapsed behind ⌄/⌃ "··· N lines ···"
      // expanders — documenting how context is handled.
      {
        name: 'repository-diff-context',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("heads.go")'],
      },
      // A removed file: the whole file shows as deletions, with the red removed tag.
      {
        name: 'repository-diff-removed',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("old_helper.go")'],
      },
      // An added file: the whole file shows as additions, with the green added tag.
      {
        name: 'repository-diff-added',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("lines.go")'],
      },
      // A renamed file: the header shows "old → new" path with the renamed tag.
      {
        name: 'repository-diff-renamed',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("renderer.go")'],
      },
      // The diff branch selector reopened while diffing: the dropdown checkmarks
      // the current compare branch, and clicking that branch (or the base) exits
      // diff mode. Enters diff mode first (open dropdown, pick a branch), then
      // reopens the now-labelled compare selector to document the checkmark.
      {
        name: 'repository-diff-branches',
        path: '/project/sim-project/repository',
        clicks: [
          'button:has(svg.lucide-git-compare)',
          'button:has-text("hydra/add-line-numbers")',
          'button[title="Change or exit branch diff"]',
        ],
      },
      // A binary image file rendered inline via the raw blob route (PLAN.md #41k).
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
      { name: 'repository-artifacts', path: '/project/sim-project/repository/main/.hydra/artifacts/screenshots' },
      // The project settings page, landing on the "All Agents" / Global Defaults
      // tab. Simulation seeds a multi-line pre-spawn script (GetConfig in
      // internal/http/simulation.go), so the capture documents the sandbox
      // policy editor with the ShellEditor's bash highlighting + line-number
      // gutter, the typed text and the highlight layer aligned. The form lives
      // in a viewport-height scroll container, so use a tall viewport to fit the
      // whole page: the pre-spawn + pre-exit editors sit near the bottom, the
      // "Diff Artifacts" editor (the [[artifacts]] scripts) below that, and the
      // "Services" editor (the [[services]], with a live "Running" status badge)
      // below that — so the viewport must be tall enough to reach the very bottom
      // (simulation seeds one of each there).
      { name: 'settings', path: '/project/sim-project/settings', viewport: { width: 1280, height: 2900 } },
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
      // edits the config, brings up the bottom-pinned FloatingSaveBar — so the
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
      // The agent detail header showing the new user-facing title: the sidebar
      // and header render the mutable title (e.g. "Add renameable agent titles")
      // in place of the stable ID, with a rename (pencil) button beside it and
      // the Copy-ID button still exposing the underlying id. Viewport-only so the
      // shot focuses on the title bar rather than the terminal/diff below.
      { name: 'agent-title', path: '/project/sim-project/agent/agent-1', viewportOnly: true },
      // The inline rename in progress: clicking the pencil swaps the title for an
      // editable input seeded with the current title (Enter saves via PATCH, Esc
      // cancels). Documents the rename UX. The pencil is the only lucide-pencil
      // icon on the page, so the :has() selector targets it unambiguously.
      { name: 'agent-rename', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button:has(svg.lucide-pencil)' },
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
      { name: 'nested-folders', path: '/project/sim-project/agent/agent-3', scrollTo: 'Changes' },
      // A read-only archived (killed/merged) agent page: no live terminal/diff,
      // just the prompt and a (not-yet-wired) Resume affordance. The grayed
      // "Archived" sidebar section itself is already visible in the `home` shot.
      { name: 'archived-agent', path: '/project/sim-project/agent/archived-1' },
      // agent-1's diff carries simulated "screenshots" artifacts (mixed phone +
      // desktop shapes). Scroll to the "Changes" header — the artifacts panel
      // renders directly below it — and use a taller viewport so the wrapped
      // before/after cards fit in one capture. Meta: a screenshot of the diff
      // page showing artifact before/after screenshots.
      //
      // The diff viewer offers four image-diff comparison modes (a setting in the
      // diff viewer; see web/src/components/ArtifactsPanel.tsx ImageDiffView). We
      // capture the artifacts panel once per mode so each option is documented:
      //   side-by-side — before and after shown next to each other (default)
      //   ab           — both stacked; click to flip between them (hard switch)
      //   slider       — draggable divider with a hard cut between before/after
      //   onion        — before/after blended via an opacity slider
      {
        name: 'artifacts',
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
      },
      {
        name: 'artifacts-slider',
        path: '/project/sim-project/agent/agent-1',
        scrollTo: 'Changes',
        viewport: { width: 1280, height: 1280 },
        imageDiffMode: 'slider',
      },
      {
        name: 'artifacts-onion',
        path: '/project/sim-project/agent/agent-1',
        scrollTo: 'Changes',
        viewport: { width: 1280, height: 1280 },
        imageDiffMode: 'onion',
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
      },
      // The artifacts panel's info (i) tooltip, opened — documents what artifacts
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
      // simulated response (internal/http/simulation.go) carries four sets —
      // changed, generating (with a live progress line), error, and no-visual-
      // changes — each in the same card. A taller viewport fits all four so the
      // states document side by side. Documents that switching states never
      // changes the card shell and refresh stays reachable in every state.
      {
        name: 'artifact-states',
        path: '/project/sim-project/agent/agent-1',
        scrollTo: 'Changes',
        viewport: { width: 1280, height: 1800 },
        imageDiffMode: 'side-by-side',
      },
      // The in-flight artifact card expanded to reveal its live generation logs:
      // the two sides (Before / After) build in parallel, each a scrollable,
      // monospaced stdout+stderr stream (stderr in red), with the header showing
      // both sides' progress joined by "·" and elapsed time. agent-1's
      // "components" set is the generating one (internal/http/simulation.go).
      {
        name: 'artifact-log',
        path: '/project/sim-project/agent/agent-1',
        scrollTo: 'Changes',
        viewport: { width: 1280, height: 1280 },
        imageDiffMode: 'side-by-side',
        expandArtifact: 'components',
      },
      // The video diff viewer (VideoDiffView) shown directly: agent-1's
      // "screenshots" set carries a .webm artifact (loader-animation.webm) the
      // panel routes to the video viewer instead of the image one. It otherwise
      // only renders inside the collapsed screenshots card, so these two shots
      // expand it and pin the .webm row to the top. The before/after pair is
      // seeked to a mid-clip frame (paused) so the progress bars differ. Two
      // shots document the two most distinct video modes:
      //   side-by-side — the Before / After clips next to each other + transport
      //   difference   — the per-frame pixel diff (changed pixels painted magenta)
      {
        name: 'artifact-video',
        path: '/project/sim-project/agent/agent-1',
        viewport: { width: 1280, height: 1000 },
        imageDiffMode: 'side-by-side',
        videoDiff: { seek: 1.2 },
      },
      {
        name: 'artifact-video-diff',
        path: '/project/sim-project/agent/agent-1',
        viewport: { width: 1280, height: 1000 },
        imageDiffMode: 'difference',
        videoDiff: { seek: 1.2 },
      },
      // ── Mobile / small-screen layout (MOBILE_PLAN.md Phase 1) ───────────────
      // The same UI captured at phone width (390×844) to document the responsive
      // work: the sidebar collapses into a hamburger-toggled off-canvas drawer,
      // the header/metadata rows wrap, padding tightens, and the diff drops its
      // file-list sidebar for a full-width unified diff. The width (<700) makes
      // each of these tag itself viewport::mobile (see the sidecar block below),
      // so a reviewer can filter the panel down to just the small-screen shots.
      //
      // The project home at phone width: the full-page spawn form fills the
      // screen and the header shows the hamburger toggle (the sidebar is off-
      // canvas / closed by default on mobile).
      { name: 'mobile-home', path: '/project/sim-project/', viewport: { width: 390, height: 844 } },
      // The drawer opened: clicking the header hamburger slides the sidebar
      // (compact spawn box, Repository button, agents list) in over a dimmed
      // backdrop. Viewport capture since the drawer is a fixed overlay.
      {
        name: 'mobile-menu',
        path: '/project/sim-project/',
        viewport: { width: 390, height: 844 },
        viewportOnly: true,
        click: 'button[aria-label="Toggle sidebar"]',
      },
      // An agent detail page at phone width: the title + action buttons wrap, the
      // metadata row wraps, and the prompt/terminal stack full-width. Viewport-
      // only to focus on the header region rather than the long page below.
      { name: 'mobile-agent', path: '/project/sim-project/agent/agent-1', viewport: { width: 390, height: 844 }, viewportOnly: true },
      // A diff at phone width: the file-list sidebar is hidden so the unified
      // diff takes the full width and wraps long lines. agent-3's nested-folder
      // diff scrolled to the Changes section.
      { name: 'mobile-diff', path: '/project/sim-project/agent/agent-3', viewport: { width: 390, height: 844 }, scrollTo: 'Changes' },
    ]
    // Capture every page in both themes. Dark mode has its own colours (e.g.
    // diff add/remove backgrounds), so a light-only render would miss visual
    // changes that only show up in dark mode. The app stores its theme
    // preference in localStorage ('hydra-theme-mode') and toggles a `dark`
    // class on <html>; we seed that key before the app boots so each capture
    // renders the chosen theme deterministically (no reliance on the OS
    // `prefers-color-scheme`). Each render is tagged by theme in its filename:
    // light renders get a `-light` suffix, dark renders a `-dark` suffix.
    const themes = ['light', 'dark'] as const
    // Each (page, theme) capture is fully independent — its own browser context
    // (isolated localStorage/cookies) hitting the shared read-only simulation
    // server — so we run several at once rather than serially. Wall-clock is
    // dominated by per-shot navigation + networkidle + settle waits, so a larger
    // pool cuts it roughly N-fold. The default scales with the host's CPU count
    // (one context per core, clamped) rather than a flat cap, so a beefy machine
    // gets more parallelism out of the box; override with HYDRA_SHOT_CONCURRENCY.
    // The clamp still bounds peak memory and avoids starving renders of CPU; the
    // captured pixels are per-context deterministic regardless of how many run in
    // parallel, so this doesn't affect the diff-hash reproducibility.
    const tasks = pages.flatMap((pg) => themes.map((theme) => ({ pg, theme })))
    const totalShots = tasks.length
    const cpuCount = (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) || 8
    const defaultConcurrency = Math.min(Math.max(cpuCount, 12), 32)
    const concurrency = Math.max(1, Math.min(Number(process.env.HYDRA_SHOT_CONCURRENCY) || defaultConcurrency, totalShots))
    let done = 0
    let nextTask = 0

    const captureShot = async (pg: (typeof pages)[number], theme: (typeof themes)[number]) => {
        const suffix = theme === 'dark' ? '-dark' : '-light'
        const ctx = await browser.newContext({
          viewport: pg.viewport ?? { width: 1280, height: 800 },
          deviceScaleFactor: 1,
          colorScheme: theme,
        })
        // Pin Date/now to a fixed instant (matching the server's simNow) so the
        // UI's "elapsed"/"X ago" labels are byte-stable across the two renders.
        // setFixedTime only freezes the wall clock — timers and requestAnimationFrame
        // keep running, so the settle() rAF wait and the setTimeout freeze below are
        // unaffected.
        await ctx.clock.setFixedTime(SIM_NOW)
        // Seed the theme preference before any app code runs.
        await ctx.addInitScript((mode) => {
          try {
            localStorage.setItem('hydra-theme-mode', mode)
          } catch {
            // ignore storage failures
          }
        }, theme)
        // Seed the diff viewer's image-diff mode so the artifacts panel renders
        // before/after pairs in the requested comparison style.
        if (pg.imageDiffMode) {
          await ctx.addInitScript((mode) => {
            try {
              localStorage.setItem('hydra-diff-image-mode', mode)
            } catch {
              // ignore storage failures
            }
          }, pg.imageDiffMode)
        }
        // Seed the repository diff's one-file-at-a-time preference so the
        // all-files-stacked view can be captured (the default is one file).
        if (pg.repoDiffSingleFile !== undefined) {
          await ctx.addInitScript((single) => {
            try {
              localStorage.setItem('hydra-repo-diff-single-file', String(single))
            } catch {
              // ignore storage failures
            }
          }, pg.repoDiffSingleFile)
        }
        // Seed the artifact tag filter so the panel renders with a filter applied.
        // The key must match web/src/lib/storage.ts artifactTagFilterKey(projectId,
        // agentId); these pages are all the sim project's agent-1.
        if (pg.tagFilter) {
          await ctx.addInitScript((f) => {
            try {
              localStorage.setItem(
                'hydra-artifact-tagfilter-v2-sim-project-agent-1',
                JSON.stringify({ scoped: f.scoped ?? {}, free: f.free ?? [] }),
              )
            } catch {
              // ignore storage failures
            }
          }, pg.tagFilter)
        }
        // Seed an unsent spawn-prompt draft so the spawn box renders pre-filled.
        // The keys must match web/src/lib/storage.ts promptDraftKey(projectId,
        // compact) for both layouts; these pages are all the sim project.
        if (pg.seedPrompt) {
          await ctx.addInitScript((text) => {
            try {
              localStorage.setItem('hydra-prompt-draft-full-sim-project', text)
              localStorage.setItem('hydra-prompt-draft-compact-sim-project', text)
            } catch {
              // ignore storage failures
            }
          }, pg.seedPrompt)
        }
        // Capture-only: widen the sidebar so the compact spawn box has more
        // horizontal room and its seeded markdown wraps less / reads better.
        // The width is React state seeded from this localStorage key (see
        // web/src/lib/storage.ts StorageKeys.sidebarWidth; __root.tsx clamps it
        // to <=600 and defaults to 264), so seeding it before boot is stable
        // across re-renders. The app's default width is unchanged outside this shot.
        if (pg.tallSpawn) {
          await ctx.addInitScript(() => {
            try { localStorage.setItem('hydra-sidebar-width', '380') } catch { /* ignore */ }
          })
        }
        await ctx.addInitScript(() => {
          // Pre-trust the simulated project so the first-open "Trust this
          // project?" modal (web/src/components/TrustProjectModal.tsx) never
          // pops up — it's a fixed inset-0 overlay that otherwise intercepts
          // every click/scroll the capture flow performs. Trust is client-side
          // localStorage keyed by project id (lib/storage StorageKeys.trustedProjects).
          try { window.localStorage.setItem('hydra-trusted-projects', '["sim-project","mobile-app"]') } catch { /* ignore */ }
          // Deterministic shuffle (spawn-form placeholder order).
          ;(Math as unknown as { random: () => number }).random = () => 0.5
          // Freeze short-lived timers (the typewriter placeholder animation runs
          // on 30–2500ms timeouts) while leaving long timers/polling intact.
          const orig = window.setTimeout
          ;(window as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
            fn: TimerHandler,
            ms?: number,
            ...rest: unknown[]
          ) => (ms && ms < 4000 ? 0 : orig(fn, ms, ...rest))) as typeof setTimeout
          // Freeze video artifacts (the .webm diff viewer auto-plays its before/
          // after pair): no-op play() so they sit paused on their first frame. The
          // artifact diff is byte-hash based, so a timing-dependent frame would make
          // any shot containing the video row flap between "modified"/"unchanged".
          // Frame 0 is identical across renders, keeping those captures stable.
          ;(HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play = () => Promise.resolve()
        })
        const page = await ctx.newPage()
        if (pg.holdRequest) {
          // Hold the matching request open (never continued/fulfilled) so the
          // page renders its in-flight loading state when captured.
          await page.route(pg.holdRequest, () => { /* hold open */ })
        }
        if (pg.stubUpload) {
          // Serve every upload-blob request (GET /uploads/.../blob) the same fixed
          // repo PNG so the prompt block's image-attachment thumbnails render a
          // deterministic image. Set before goto so the initial chip <img> loads
          // are fulfilled (and networkidle can settle). Read once per shot.
          const buf = readFileSync(join(SRC, pg.stubUpload))
          await page.route('**/uploads/**', (route) =>
            route.fulfill({ status: 200, contentType: 'image/png', body: buf }),
          )
        }
        // A held request keeps the network busy forever, so networkidle would
        // never resolve — wait only for the DOM for those pages.
        await page.goto(base + pg.path, { waitUntil: pg.holdRequest ? 'domcontentloaded' : 'networkidle' })
        await page.addStyleTag({
          content:
            '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        })
        if (pg.holdRequest) {
          // Wait for the main pane's loading spinner (the h-5 LoaderCircle, unique
          // to the loading state — the tree spinner is h-4, the header one h-3.5).
          // It only appears once branches + tree have loaded and the held file
          // request is in flight, so this confirms the full loading layout.
          await page.waitForSelector('svg.lucide-loader-circle.h-5')
        }
        // Let async data + layout settle before capturing (fonts + frames, no sleep).
        await settle(page)
        // The simulated agent terminal streams a fixed boot transcript over its
        // WebSocket (SimulationServer.HandleTerminalWS), ending in a shell prompt.
        // The WS isn't tracked by networkidle, and xterm renders on its own frame,
        // so wait until that final prompt has painted — otherwise a capture could
        // race the stream and show a partially-rendered terminal (a spurious diff).
        // Guarded on the terminal's presence so pages without one just skip it.
        if (await page.locator('.xterm-rows').count()) {
          await page.waitForFunction(() =>
            (document.querySelector('.xterm-rows')?.textContent ?? '').includes('agent@hydra-sim:~$'),
          )
          await settle(page)
        }
        if (pg.stubUpload) {
          // Wait until the prompt block's image-attachment chips have rendered
          // (each image chip carries an aria-label="View <file>") so the capture
          // always includes the thumbnails. The detail page resolves this agent
          // via the one-shot getAgent fallback, so the chips appear shortly after
          // load; this guards the (otherwise rare) race against settle().
          await page.waitForFunction(() => document.querySelectorAll('[aria-label^="View "]').length > 0)
          await settle(page)
        }
        if (pg.tallSpawn) {
          // Capture-only height override: enlarge both spawn boxes so the seeded
          // markdown draft (multi-paragraph + a fenced code block) shows in full
          // instead of scrolling within the default-sized box. The resize grip
          // carries title="Drag to resize" and is a direct child of each spawn
          // card (cardRef), so its parent IS the card; the compact sidebar box is
          // told apart by its rounded-[10px] shell (the full box is rounded-[14px]).
          // We set height directly — the textarea wrapper is flex-1 min-h-0, so it
          // fills the taller card. This never touches the app's real default sizes.
          await page.evaluate(({ compactH, fullH }) => {
            document.querySelectorAll('[title="Drag to resize"]').forEach((handle) => {
              const card = (handle as HTMLElement).parentElement
              if (!card) return
              const h = card.className.includes('rounded-[10px]') ? compactH : fullH
              card.style.height = `${h}px`
              card.style.minHeight = `${h}px`
            })
          }, { compactH: 500, fullH: 500 })
          await settle(page)
        }
        if (pg.attachImages) {
          // Stub the upload endpoint so it resolves instantly and deterministically
          // (no disk writes, no timing jitter) — the chips then leave their
          // "uploading" state at a fixed point.
          await page.route('**/uploads/**', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ path: '/sim/.hydra/uploads/upload.png', filename: 'upload.png' }),
            }),
          )
          // Feed the files into the hidden <input type=file>. Naming each
          // "image.png" exercises the form's numbered-paste renaming.
          await page.setInputFiles(
            'input[type=file]',
            pg.attachImages.map((rel) => ({
              name: 'image.png',
              mimeType: 'image/png',
              buffer: readFileSync(join(SRC, rel)),
            })),
          )
          // Wait until every chip has rendered (its View label is present) and
          // none is still uploading (no spinner), so the layout is stable.
          await page.waitForFunction(
            (n) =>
              document.querySelectorAll('[aria-label^="View "]').length === n &&
              !document.querySelector('svg.lucide-loader-circle'),
            pg.attachImages.length,
          )
          // Open the lightbox on the first image.
          await page.click('[aria-label^="View "]')
          // Wait for the figure's caption to show the pixel dimensions ("W × H"),
          // which only render after the image's onLoad fires — so the capture
          // always includes them.
          await page.waitForFunction(() =>
            !!document.querySelector('figure figcaption')?.textContent?.includes('×'),
          )
          await settle(page)
        }
        if (pg.imageDiffMode || pg.expandArtifact) {
          // The artifacts panel populates from a WebSocket snapshot, which (unlike
          // the HTTP fetches the goto's networkidle waits for) isn't tracked by
          // networkidle. Wait for the always-present "screenshots" card so the
          // panel is rendered before we capture it.
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('screenshots')),
          )
          await settle(page)
        }
        if (pg.expandArtifact) {
          // Expand the named artifact card so its body (e.g. the live generation
          // log) is visible. The card only exists once the artifacts WS snapshot
          // has populated it, so wait for the header button to appear first.
          await page.waitForFunction(
            (name) => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes(name)),
            pg.expandArtifact,
          )
          await page.evaluate((name) => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(name))
            btn?.click()
          }, pg.expandArtifact)
          await settle(page)
        }
        if (pg.click) {
          // Open a popover (e.g. the branch selector) so the capture documents it.
          await page.click(pg.click)
          await settle(page)
        }
        if (pg.clicks) {
          // Drive a short interaction (e.g. press the diff button, then open the
          // compare branch selector). The final networkidle wait lets the diff
          // a click fetched render before the capture.
          for (const sel of pg.clicks) {
            await page.click(sel)
            await settle(page)
          }
          await page.waitForLoadState('networkidle')
          await settle(page)
        }
        if (pg.disableSettingsEntries) {
          // Flip the seeded artifact + service entries to disabled. Each section's
          // single entry carries exactly one EnabledToggle — its sr-only "peer"
          // checkbox is the only such input inside that section card (the network
          // toggle lives in the separate agent-config card), so scoping to the
          // card's heading targets it unambiguously. Clicking an already-checked
          // toggle flips enabled→false: the card mutes + reads "Disabled", and the
          // config goes dirty so the FloatingSaveBar slides in at the bottom.
          await page.evaluate(() => {
            for (const heading of ['Diff Artifacts', 'Services']) {
              const h2 = Array.from(document.querySelectorAll('h2')).find((e) => e.textContent?.trim() === heading)
              const card = h2?.closest('.rounded-xl') as HTMLElement | null
              const toggle = card?.querySelector('input.sr-only') as HTMLInputElement | null
              if (toggle?.checked) toggle.click()
            }
          })
          await settle(page)
        }
        if (pg.scrollTo) {
          // Pin the named section heading to the top of its scroll container. We
          // can't use scrollIntoViewIfNeeded: the diff header is position:sticky,
          // so the browser already counts it as "in view" and won't scroll.
          // Compute the heading's offset within the scroll container and set
          // scrollTop directly.
          await page.evaluate((heading) => {
            const title = Array.from(document.querySelectorAll('h2')).find(
              (e) => e.textContent?.trim() === heading,
            )
            const cont = title?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (title && cont) {
              const offset =
                title.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              cont.scrollTop = offset - 24
            }
          }, pg.scrollTo)
          // Settle the scroll/sticky-header layout before capturing.
          await settle(page)
        }
        if (pg.expandArtifact) {
          // Pin the expanded card to the top so its live log is the focus of the
          // shot (the default-expanded "screenshots" card above it is tall). Same
          // sticky-aware offset technique as scrollTo, but targeting the card.
          await page.evaluate((name) => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(name))
            const card = btn?.closest('div.rounded-lg') as HTMLElement | null | undefined
            const cont = card?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (card && cont) {
              const offset = card.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              // Leave generous headroom so the card's top clears the sticky
              // "Changes" header that floats over the top of the scroll container.
              cont.scrollTop = offset - 96
            }
          }, pg.expandArtifact)
          await settle(page)
        }
        if (pg.videoDiff) {
          // Expand the "screenshots" card so its .webm row mounts, seek the
          // before/after pair to the requested frame, then pin the row to the top.
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('screenshots')),
          )
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('screenshots'))
            btn?.click()
          })
          // The video viewer mounts <video> elements once the card expands. Wait
          // for them to be attached, not visible: the difference mode keeps its
          // videos hidden (only the diff canvas shows), so a visibility wait would
          // time out there.
          await page.waitForSelector('video', { state: 'attached' })
          await settle(page)
          // Seek every video to the shared time and wait for the frame to land.
          // play() is a no-op (init script), so the pair stays paused on the
          // seeked frame, which is identical across renders (byte-stable). The
          // fallback timeout must exceed 4000ms — the init script collapses
          // shorter timers to 0, which would resolve before the seek completes.
          await page.evaluate(async (t) => {
            const vids = Array.from(document.querySelectorAll('video'))
            await Promise.all(vids.map((v) => new Promise<void>((res) => {
              v.pause()
              if (Math.abs(v.currentTime - t) < 0.001) return res()
              const done = () => { v.removeEventListener('seeked', done); res() }
              v.addEventListener('seeked', done)
              try { v.currentTime = t } catch { res() }
              setTimeout(res, 5000)
            })))
          }, pg.videoDiff.seek)
          // Pin the .webm file row to the top of the scroll container (same
          // sticky-aware offset technique as scrollTo/expandArtifact).
          await page.evaluate(() => {
            const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent?.trim() === 'loader-animation.webm')
            const row = span?.closest('div.rounded-lg') as HTMLElement | null | undefined
            const cont = row?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (row && cont) {
              const offset = row.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              cont.scrollTop = offset - 96
            }
          })
          // The difference mode redraws its pixel-diff canvas on a throttled rAF
          // loop; give it real time (playwright timers, not the page's frozen
          // setTimeout) to draw the seeked frame at least once. Once drawn the
          // pixels are identical every iteration (the pair is paused), so the
          // shot stays byte-stable.
          await page.waitForTimeout(400)
          await settle(page)
        }
        if (pg.artifactInfo) {
          // Place the "Artifacts" heading at mid-viewport so the tooltip — which
          // opens upward from the (i) icon into a fixed portal — has room above it,
          // then hover the icon to open it. (Same sticky-aware offset technique as
          // scrollTo, but centering rather than pinning to the top.)
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('h3')).some((h) => h.textContent?.trim() === 'Artifacts'),
          )
          await page.evaluate(() => {
            const h3 = Array.from(document.querySelectorAll('h3')).find((e) => e.textContent?.trim() === 'Artifacts')
            const cont = h3?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (h3 && cont) {
              const offset = h3.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              // Put the heading ~60% down the container: the tooltip opens upward,
              // so the lower the icon sits, the more room it has (and the less risk
              // of clipping at the top of the viewport).
              cont.scrollTop = offset - cont.clientHeight * 0.6
            }
          })
          await settle(page)
          // Hover the info icon next to the "Artifacts" heading (the InfoTooltip's
          // Info svg carries cursor-help) so React's onMouseEnter opens the portal.
          await page
            .locator('xpath=//h3[normalize-space()="Artifacts"]/parent::*//*[name()="svg" and contains(@class,"cursor-help")]')
            .hover()
          await settle(page)
        }
        if (pg.openFilter) {
          // Open the named tag-filter dropdown so the capture documents the menu.
          // Its trigger is a button whose lowercase <span> holds the scope label
          // (the category name, e.g. "theme"). Done after scrollTo so the header —
          // and the dropdown that opens just below it — sits in the viewport.
          await page.waitForFunction(
            (label) => Array.from(document.querySelectorAll('button')).some(
              (b) => b.querySelector('span.lowercase')?.textContent?.trim() === label),
            pg.openFilter,
          )
          await page.evaluate((label) => {
            const btn = Array.from(document.querySelectorAll('button')).find(
              (b) => b.querySelector('span.lowercase')?.textContent?.trim() === label)
            btn?.click()
          }, pg.openFilter)
          await settle(page)
        }
        const out = join(OUT, `${pg.name}${suffix}.png`)
        // Scrolled pages, the lightbox (a fixed, viewport-filling overlay),
        // header-focused shots and the hovered info tooltip (a fixed portal)
        // capture the viewport; others capture the full page.
        await page.screenshot({ path: out, fullPage: !pg.scrollTo && !pg.attachImages && !pg.viewportOnly && !pg.artifactInfo && !pg.videoDiff })
        // Emit the tag sidecar (<file>.png.meta, {"tags":[...]}) that the diff
        // viewer reads (internal/artifacts readTagsSidecar). theme + viewport +
        // section are scoped "category::value" labels — the viewer keeps one
        // value per category and offers each as a single-select filter — so a
        // reviewer can, e.g., show only the dark-mode repository shots. The
        // viewport axis is derived from the capture width: a narrow (phone-width)
        // shot tags itself viewport::mobile, everything wider viewport::desktop.
        const viewport = (pg.viewport?.width ?? 1280) < 700 ? 'mobile' : 'desktop'
        const tags = [`theme::${theme}`, `viewport::${viewport}`, `section::${sectionFor(pg.name)}`]
        writeFileSync(`${out}.meta`, JSON.stringify({ tags }))
        console.log(`wrote ${out}`)
        await ctx.close()
        done++
        // Progress marker surfaced live by Hydra as the header, e.g.
        // "artifact-log-dark.png 7/24". Emitted as each shot finishes (order is
        // nondeterministic under the pool) so the count climbs steadily.
        progress(`${pg.name}${suffix}.png ${done}/${totalShots}`)
    }

    // Worker pool: each worker pulls the next task index until the list drains.
    // JS is single-threaded between awaits, so nextTask++/done++ never race.
    const worker = async () => {
      while (nextTask < tasks.length) {
        const { pg, theme } = tasks[nextTask++]
        await captureShot(pg, theme)
      }
    }
    progress(`capturing ${totalShots} screenshots (${concurrency} at a time)`)
    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    // Record a real animated UI element to a lossless .webm so the screenshots
    // artifact also exercises the video diff viewer (web/src/components/
    // VideoDiffView.tsx) — the moving-picture twin of the PNG shots. We capture
    // the repository view's loading spinner (a LoaderCircle with Tailwind
    // animate-spin) over one full rotation.
    //
    // The diff viewer compares video by byte hash (it can't decode pixels
    // server-side), so the .webm MUST be byte-reproducible or every comparison
    // would read "modified". Two sources of nondeterminism are removed:
    //   * The spin is a CSS animation, so we DON'T let it free-run on the wall
    //     clock. Pausing it via the Web Animations API doesn't stick (a style
    //     recalc resets the CSS animation-play-state back to running), so instead
    //     we kill all CSS animation and drive the rotation ourselves with an
    //     explicit inline transform per frame — animate-spin IS a rotate, so this
    //     reproduces the exact frames the animation would show, but deterministically.
    //   * ffmpeg's libvpx-vp9 -lossless encode is deterministic for identical
    //     input frames, but the WebM muxer stamps a wall-clock date + version
    //     strings by default; -flags/-fflags +bitexact drop those. yuv444p keeps
    //     full chroma (no subsampling), so the encode is genuinely lossless.
    // (Verified: two full runs produce byte-identical .webm output.)
    const SPIN_FRAMES = 12 // one rotation at 12fps → a 1s clip
    const ffmpegBin = ffmpegStatic as unknown as string
    const recordSpinner = async (theme: (typeof themes)[number]) => {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1, colorScheme: theme })
      await ctx.clock.setFixedTime(SIM_NOW)
      await ctx.addInitScript((mode) => { try { localStorage.setItem('hydra-theme-mode', mode) } catch { /* ignore */ } }, theme)
      await ctx.addInitScript(() => { try { window.localStorage.setItem('hydra-trusted-projects', '["sim-project"]') } catch { /* ignore */ } })
      const page = await ctx.newPage()
      try {
        // Hold the file-contents request so the repository view stays in its
        // loading state (centered spinner) — same trick as the repository-loading
        // shot. NOTE: no animation-killing stylesheet here; we need the spin.
        await page.route('**/repository/file*', () => { /* hold open */ })
        await page.goto(base + '/project/sim-project/repository', { waitUntil: 'domcontentloaded' })
        const spinner = page.locator('svg.lucide-loader-circle.h-5')
        await spinner.waitFor()
        await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready })
        // Kill every CSS animation/transition so nothing rotates on the wall
        // clock; we set the spinner's rotation explicitly per frame below.
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' })
        // Square clip centered on the spinner: the spinner on the loading pane's
        // background. The box is deterministic (fixed layout), so the clip is too.
        const box = await spinner.boundingBox()
        if (!box) throw new Error('loading spinner has no bounding box')
        const side = 120
        const clip = {
          x: Math.round(box.x + box.width / 2 - side / 2),
          y: Math.round(box.y + box.height / 2 - side / 2),
          width: side,
          height: side,
        }
        const tmp = mkdtempSync(join(tmpdir(), 'hydra-spin-'))
        for (let i = 0; i < SPIN_FRAMES; i++) {
          const deg = (i / SPIN_FRAMES) * 360
          await spinner.evaluate((el, d) => { (el as SVGElement).style.transform = `rotate(${d}deg)` }, deg)
          // Commit the transform before the shot (two rAFs, like settle()).
          await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
          await page.screenshot({ path: join(tmp, `f${String(i).padStart(3, '0')}.png`), clip })
        }
        const out = join(OUT, `loading-spinner-${theme}.webm`)
        const r = spawnSync(ffmpegBin, [
          '-y', '-nostdin', '-loglevel', 'error',
          '-framerate', '12', '-i', join(tmp, 'f%03d.png'),
          '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv444p',
          '-g', '12', '-threads', '1', '-an',
          '-flags', '+bitexact', '-fflags', '+bitexact',
          out,
        ], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr}`)
        // No viewport:: tag — a small spinner clip has no meaningful viewport, and
        // the built-in image/video type filter already distinguishes the .webm.
        writeFileSync(`${out}.meta`, JSON.stringify({ tags: [`theme::${theme}`, 'section::repository'] }))
        console.log(`wrote ${out}`)
      } finally {
        await ctx.close()
      }
    }
    progress('recording spinner video')
    for (const theme of themes) await recordSpinner(theme)
  } finally {
    await browser.close()
  }
} finally {
  server.kill('SIGTERM')
}

progress('done')
