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
// ({"tags": [...], "dpi": 2}) that the diff viewer surfaces as labels + filters (see
// internal/artifacts readSidecar). Every shot is tagged with its theme, viewport, and
// UI section as scoped "category::value" labels. The optional "dpi" records the
// device-scale factor the shot was captured at (phone shots use 2 for crispness); the
// grid sizes a tile by its logical width (physical px ÷ dpi), so dpi 2 lays out the
// same as dpi 1, only sharper. Absent ⇒ 1.
//
// Run with: bun scripts/screenshots/take-screenshots.ts  (from web/)
//
// Progress: each major step emits a one-line "::hydra:progress::" marker (build
// phases and, during capture, "<name>.png <n>/<total>"). Hydra strips the prefix
// and surfaces the rest as the live progress header — and, once it sees a marker,
// stops treating ordinary stdout as progress, so the noisy subprocess output
// (bun install, vite build) below can't hijack the header. Keep markers short and
// human-readable; everything still lands in the full build log.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import ffmpegStatic from 'ffmpeg-static'

// Share the app's localStorage key registry rather than re-typing the 'hydra-*'
// strings: keys are built here in Node and passed into the browser-context init
// scripts below. storage.ts is dependency-free, so it imports cleanly under bun.
import { StorageKeys, artifactTagFilterKey, promptDraftKey } from '../../src/lib/storage'

// Identifiers seeded by the simulation server (internal/http/simulation.go),
// named where they feed the shared key builders above.
const SIM_PROJECT = 'sim-project'
const SIM_AGENT = 'agent-1'

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

// A short instruction typed into the spawn box, paired with PASTED_LOG_DEMO
// below: the demo shows the user describing a task and then pasting a big log,
// which lands as an attachment chip rather than swamping the instruction.
const PASTED_TEXT_INSTRUCTION = 'The CI build started failing on main — here is the full log, figure out which step broke and why:'

// A long plain-text block (a CI log) pasted into the spawn box to demo the
// "large paste becomes an attachment" behavior. Well over the 8-line threshold,
// so the first paste is captured as a pasted-text-1.txt chip instead of being
// dumped into the textarea.
const PASTED_LOG_DEMO = [
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

// A multi-line HTML snippet "copied from an editor" (the clipboard carries a
// `html` language via vscode-editor-data). Pasting it once attaches it; pasting
// it a second time inlines it for real, wrapped in a ```html fence — the
// code-paste path. Over the 8-line threshold so the first paste attaches.
const PASTED_HTML_DEMO = [
  '<section class="hero">',
  '  <h1>Spawn an Agent</h1>',
  '  <p>Describe what you need — and consider it done.</p>',
  '  <form class="spawn">',
  '    <label for="task">Task</label>',
  '    <textarea id="task" placeholder="Describe a task…"></textarea>',
  '    <div class="actions">',
  '      <button type="submit">Spawn</button>',
  '    </div>',
  '  </form>',
  '</section>',
].join('\n')

const OUT = required('HYDRA_ARTIFACT_OUTPUT')
// HYDRA_ARTIFACT_SOURCE is the checkout root. Fall back to the repo root three
// levels up from this script (web/scripts/screenshots/) so it also works by hand.
const SRC = process.env.HYDRA_ARTIFACT_SOURCE || join(import.meta.dir, '..', '..', '..')
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
  if (name.startsWith('agent-approvals')) return 'approvals'
  if (name.startsWith('agent-')) return 'agent'
  if (name.startsWith('spawn')) return 'spawn'
  if (name.startsWith('settings') || name === 'services-warning') return 'settings'
  if (name.startsWith('diff') || name === 'nested-folders') return 'diff'
  if (name.startsWith('toast')) return 'toast'
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

// captureWithRetry takes a screenshot, retrying a handful of times on the
// transient Chromium protocol errors that surface under load. With up to ~32
// headless contexts capturing in parallel (see the worker pool), a fullPage
// grab can intermittently fail with "Unable to capture screenshot" when several
// large captures coincide and momentarily exhaust the renderer — even though the
// page itself is fine. Without a retry, one such blip rejects the whole run, so
// the diffed side renders nothing (the symptom: "after side failed to render").
// Backing off lets sibling captures finish and free memory; the pixels are
// per-context deterministic, so a retry produces the identical image (the
// diff-hash stays reproducible). A non-transient error is rethrown immediately.
async function captureWithRetry(page: import('playwright').Page, opts: Parameters<import('playwright').Page['screenshot']>[0]) {
  const transient = /capture screenshot|Unable to capture|Target (page|frame)?.*closed|Protocol error/i
  const attempts = 4
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.screenshot(opts)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i === attempts || !transient.test(msg)) throw err
      console.log(`  capture retry ${i}/${attempts - 1} after transient error: ${msg.split('\n')[0]}`)
      await page.waitForTimeout(400 * i) // linear backoff: let sibling captures drain
      await settle(page).catch(() => { /* page still settling; the retry will catch a real failure */ })
    }
  }
}

// Fixed seek time (seconds) for the simulated loader clips — shared by the
// dedicated videoDiff shots and the showArtifacts grid so every webm tile across
// every shot decodes the identical, reproducible frame. Must be an absolute
// timestamp, not duration-relative (see ensureVideosPainted).
const VIDEO_SEEK = 1.2

// ensureVideosPainted forces every <video> on the page to decode and present a
// stable, deterministic frame so its diff tile actually paints pixels instead of
// showing through to the transparent checkerboard backdrop (checkerStyle). This
// is the flaky "loader-animation.webm renders transparent" symptom: play() is
// no-op'd by the init script, so nothing advances the video on its own, and a
// bare 'seeked' event can fire BEFORE the frame is really decodable — so the
// capture races the first-frame decode and intermittently grabs an empty tile.
//
// Robustness comes from verifying an actual decoded frame exists (a 16×16 canvas
// read-back: drawImage of an undecoded video yields all-transparent pixels) and
// retrying the seek until it does. Timing is driven by requestVideoFrameCallback
// (fires exactly when a frame is composited) with a requestAnimationFrame fallback
// — both deliberately, because the init script collapses every setTimeout under
// 4000ms to 0, so a short setTimeout-based wait would resolve before any decode.
//
// `seek` pins an explicit absolute time. ALWAYS pass one for the simulated
// loader clips: they're MediaRecorder-produced webm with no duration in the
// header, so v.duration is *estimated from buffering* and drifts run-to-run —
// deriving the target from it (e.g. duration * 0.6) lands on a different frame
// each run (the bottom-of-frame webm sliver was exactly this flap). A fixed
// timestamp decodes the same frame every time. The duration-based fallback below
// exists only for hypothetical future clips that carry a real duration.
async function ensureVideosPainted(page: import('playwright').Page, seek?: number) {
  await page.evaluate(async (fixedSeek) => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const probe = document.createElement('canvas')
    probe.width = probe.height = 16
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    // True once the video holds a decoded, non-transparent current frame — i.e.
    // the tile (and any Highlight DiffCanvas drawn from it) will paint real pixels
    // rather than the checkerboard. drawImage works on hidden videos too, so this
    // also covers the Highlight modes that keep the <video>s off-screen.
    const hasFrame = (v: HTMLVideoElement) => {
      if (!pctx || !v.videoWidth || !v.videoHeight) return false
      try {
        pctx.clearRect(0, 0, 16, 16)
        pctx.drawImage(v, 0, 0, 16, 16)
        const d = pctx.getImageData(0, 0, 16, 16).data
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true
      } catch { /* not decodable yet (or briefly tainted mid-seek) */ }
      return false
    }
    const paint = async (v: HTMLVideoElement) => {
      v.pause()
      // Fully buffer the clip before seeking. This is the crux of the fix: a webm
      // below the fold loads under preload="auto" but stays PARTIALLY buffered, and
      // VP9 decode off a partial buffer is nondeterministic — the seeked frame
      // lands a frame off (light theme's moving progress bar) or simply decodes
      // with slight pixel noise (dark theme), so the tile flapped run to run while
      // the fully-buffered dedicated shots stayed stable. Kick one load() (NOT one
      // per tick — repeated load() restarts buffering and never converges) then
      // wait for HAVE_ENOUGH_DATA. These clips are tiny (~9KB / 2s) so it's quick.
      try { v.load() } catch { /* ignore */ }
      for (let frame = 0; frame < 600 && v.readyState < 4 /* HAVE_ENOUGH_DATA */; frame++) await raf()
      const target = fixedSeek != null
        ? fixedSeek
        : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration * 0.6 : 0.05)
      // Exit only when the seek has fully SETTLED on a decoded frame: a non-
      // transparent frame (hasFrame) is necessary but not sufficient, because
      // mid-seek the element can briefly paint an intermediate frame. Gate on
      // !v.seeking so we wait for the seek to complete; once it has, currentTime
      // holds the deterministic snapped-to-nearest frame and a paused clip (play()
      // is no-op'd) stays there. Re-issue the seek only if it clearly never took
      // (idle but > 0.5s off target — a frame-boundary snap is far smaller).
      for (let frame = 0; frame < 360; frame++) {
        if (!v.seeking) {
          if (Math.abs(v.currentTime - target) > 0.5) {
            try { v.currentTime = target } catch { /* not seekable yet */ }
          } else if (hasFrame(v)) break
        }
        await Promise.race([
          new Promise<void>((r) => v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : r()),
          raf(),
        ])
      }
    }
    await Promise.all(Array.from(document.querySelectorAll('video')).map(paint))
  }, seek ?? null)
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
  //    The diff viewer surfaces files that differ between the two versions. It
  //    starts from a byte hash but refines that with a pixel-level decode (see
  //    internal/artifacts Manager.Compare), so renders need only be PIXEL-stable,
  //    not byte-identical — cosmetic encoder/metadata jitter is ignored. We still
  //    pin the obvious sources of *visible* nondeterminism so unchanged UI never
  //    reads as "modified":
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
      // Explicit viewport:: tag override. The axis is otherwise derived from the
      // capture width alone (narrow → mobile), which can't tell a landscape phone
      // (wide but short) from a tablet, so landscape/tablet shots set it directly.
      // One of mobile | mobile-landscape | tablet | tablet-landscape | desktop.
      viewportTag?: 'mobile' | 'mobile-landscape' | 'tablet' | 'tablet-landscape' | 'desktop'
      // CSS selector clicked once (after load, before capture) — used to open a
      // popover such as the repository branch selector so the screenshot
      // documents it.
      click?: string
      // CSS selector hovered (after load, before capture) — opens a hover-only
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
      // keyboard-shortcuts overlay the way a user does — by pressing `?`.
      pressKey?: string
      // Glob of a request to hold open (never fulfilled) so the page is captured
      // in its in-flight loading state — e.g. holding the repo file-contents
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
      // Expands the named artifact card (clicks its header) after load — used to
      // document the in-flight card's live, scrollable generation log.
      expandArtifact?: string
      // Types a query into the artifacts panel's search box after load — used to
      // document that search narrows like the tag filter (cards stay put, their
      // header counts reflect the narrowing) rather than removing non-matching
      // cards or auto-expanding them. Only meaningful on the artifacts (agent-1)
      // page; pair with imageDiffMode.
      searchArtifacts?: string
      // Expands the ready "screenshots" card and pins it to the top, then eager-loads
      // every tile image and waits for the masonry to settle — so the capture shows
      // the actual before/after artifacts (the card defaults to collapsed, which
      // otherwise leaves these shots showing only the header row). Only meaningful on
      // the artifacts (agent-1) page; pair with imageDiffMode.
      showArtifacts?: boolean
      // Ticks the "Highlight" checkbox on every before/after image tile (after
      // showArtifacts has expanded the card), so the magenta pixel-diff overlay
      // (DiffCanvas) is captured painted over each changed image. Only meaningful
      // with imageDiffMode 'ab' + showArtifacts — the AB switch and its Highlight
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
      // fullscreen comparator to this mode (by the selector's button label) — shows
      // before/after, onion, etc. working inside the lightbox. Only meaningful with
      // openArtifactImage.
      lightboxMode?: string
      // After openArtifactImage (+ any lightboxMode), magnify the lightbox comparator
      // with the scroll-wheel so the zoom/pan chrome — the bottom-right minimap and
      // "Reset view (N×)" button — is on screen, documenting the lightbox zoom feature.
      // The zoom is a pure function of the (fixed) wheel amount, so the shot stays
      // reproducible. Only meaningful with openArtifactImage.
      lightboxZoom?: boolean
      // Eager-loads every masonry tile image and waits for the layout to settle
      // before capturing — for the repository artifacts view, whose masonry is shown
      // without an expand step. Keeps the width-driven layout byte-reproducible
      // (lazy/off-screen tiles would otherwise load inconsistently). No-op when the
      // page has no masonry tiles.
      settleMasonry?: boolean
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
      // Scrolls the matched element into the middle of the viewport (after any
      // click/settleMasonry steps), then captures the viewport — for content that
      // lives at the bottom of an inner scroll container the full-page capture
      // can't reach (the document body doesn't scroll). Used to reveal the
      // repository artifacts "Show build log" terminal.
      revealSelector?: string
      // Forces a coarse (touch) pointer: makes the `(hover: hover) and (pointer:
      // fine)` media query report false, so keyboard-only affordances (shortcut
      // hints) hide exactly as they do on a real phone. The harness otherwise only
      // sets a small viewport — Chromium still reports a fine mouse pointer — so a
      // mobile shot of a menu would wrongly show desktop shortcut hints. Set this on
      // the small-screen shots whose chrome is keyboard-gated.
      coarsePointer?: boolean
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
      // Seeds the remembered agent→model map (StorageKeys.defaultModel) before
      // boot, so the spawn form's agent+model picker renders with a model already
      // selected (the trigger shows its label; the row is checked) — used to
      // document the model selector without driving clicks through the menu.
      seedModel?: Record<string, string>
      // Dispatches a real paste of `text` into the full-page spawn textarea
      // (with the upload endpoint stubbed so the chip settles instantly), to
      // document the large-text-paste behavior: a paste over the line threshold
      // is attached as a pasted-text-N.txt chip rather than dumped into the box.
      // `vscodeMode` adds the VS Code clipboard language tag so the paste reads
      // as code; `again` fires the paste twice so the second one inlines the
      // block for real — fenced as ```<vscodeMode> when it's code. Pairs with
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
      // itself — documenting that the portal-rendered menu overlays the content
      // instead of being clipped by the sidebar's `overflow-hidden`. Capture-time
      // override only; the app's default width is unchanged.
      narrowSidebar?: boolean
      // Focuses the full-page spawn textarea and selects ALL of its text after the
      // page settles, so the capture overlays the browser's selection band (which
      // marks the REAL, selectable text positions) on top of the highlight backdrop
      // — making any drift between the two layers obvious. Used to prove the fenced
      // code block highlighting stays glyph-aligned with the textarea. Pairs with
      // seedPrompt + tallSpawn.
      selectSpawnText?: boolean
      // Seeds the artifact tag filter (localStorage key built from project+agent)
      // before the app boots, so the artifacts panel renders with a filter applied.
      // Each array lists a scope's HIDDEN values (e.g. { theme: ['dark'] } drops
      // the dark shots) — documents the header tag filter actively in use plus the
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
      // and it has to flip downward instead of being clipped off-screen — the
      // regression shot for the tooltip flip fix. Captures the viewport (the
      // card is a fixed portal). Only meaningful on a tests-panel agent page.
      testsInfo?: boolean
      // Expands the "screenshots" card, seeks its loader-animation.webm pair to
      // the given time (paused), and pins that row to the top — so the capture
      // shows the video diff viewer (VideoDiffView) directly rather than buried
      // in a collapsed "N changed" card. Captures the viewport. The seek lands a
      // mid-clip frame so the before/after progress bars differ; the page's
      // play() no-op keeps the pair paused so the frame is byte-stable. Only
      // meaningful on the artifacts (agent-1) page, paired with imageDiffMode.
      // `highlight` clicks the video's "Highlight" tab (the magenta per-frame
      // pixel-diff, which now lives inside Before/After) — pair with imageDiffMode 'ab'.
      videoDiff?: { seek: number; highlight?: boolean }
      // Settings only: turn OFF the "Enabled" switch on the seeded [[artifacts]]
      // and [[services]] entries (the EnabledToggle in web/.../SettingsComponents).
      // Flipping each to disabled both mutes/labels its card "Disabled" AND marks
      // the config dirty, so the bottom-pinned FloatingSaveBar appears — one shot
      // documenting the disabled-entry styling and the floating save affordance.
      // Pair with scrollTo: 'Diff Artifacts' so the two editors fill the viewport.
      disableSettingsEntries?: boolean
      // Scrolls the diff so the named file's header (a path substring) is pinned
      // beneath the sticky "Changes" toolbar, with part of that file's body
      // scrolled under the now-stuck header — documents the sticky file header
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
      // (agent-2 in the simulation), and the project dropdown — opened here —
      // shows a per-project unread count badge, with a dot on the folder button
      // when other projects have updates waiting (see simulation.go ListProjects /
      // ListAgents and AgentSidebarItem).
      { name: 'unread-indicator', path: '/', click: 'button[aria-label="Select project"]' },
      // The uncommitted-changes warning next to the Repository button (the
      // simulation reports a dirty .hydra/config.toml — see simulation.go
      // GetRepositoryPushStatus), opened to its commit popover: the dirty path
      // list plus the prefilled message input and "Commit all" button.
      { name: 'uncommitted-changes-popover', path: '/project/sim-project/', click: '[data-testid="uncommitted-chip"]' },
      // The project switcher opened over a deliberately narrow sidebar. The menu
      // (fixed w-72) is far wider than the sidebar, so it must overlay the content
      // area rather than be clipped by the sidebar's `overflow-hidden` — verifies
      // the portal-rendered menu (mirrors the Ctrl+` switcher's forced-open state).
      { name: 'project-switcher-narrow', path: '/', click: 'button[aria-label="Select project"]', narrowSidebar: true },
      // Notification toasts (web/src/lib/useAgentNotifications.ts). These fire on
      // live status transitions / security-gate parks that the static simulation
      // never produces, so they're rendered deterministically via the toast
      // harness over the settings page (a route that loads no project agents, so
      // nothing else pops a toast). Messages mirror the real ones the hook emits.
      // 1. An agent crossed into needs_input — "<bot> <agent> transitioned to
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
      // 2. An agent finished — same row, green "finished" pill; auto-dismisses at 8s.
      {
        name: 'toast-finished',
        path: '/settings',
        toast: {
          message: '"Add renameable agent titles" transitioned to finished',
          type: 'success',
          agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', status: 'finished' },
        },
      },
      // 2b. Merge-lifecycle toasts (AgentDetail armMerge/executeMerge + the
      // background auto-merge detector in agentStore): the same agent card, with
      // the pill/copy describing the merge instead of a status transition.
      // Queued (auto-merge armed) — text-only row (no pill), with the emerald
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
      // In-flight merge — persistent (dismissed when the POST settles), green
      // "merging" pill leading the row.
      {
        name: 'toast-merging',
        path: '/settings',
        toast: {
          message: 'Merging agent "Add renameable agent titles" into main…',
          type: 'info',
          agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', status: 'merging', before: '', after: 'into `main`…' },
        },
      },
      // Merge landed — green "merged" pill (also what a background auto-merge pops).
      {
        name: 'toast-merged',
        path: '/settings',
        toast: {
          message: 'Agent "Add renameable agent titles" merged into main',
          type: 'success',
          agentTransition: { agentName: 'Add renameable agent titles', agentId: 'agent-md', projectId: 'sim-project', status: 'merged', before: '', after: 'into `main`' },
        },
      },
      // 2c. A plain message toast with a `backtick` branch pill — the sidebar
      // Sync button's success toast (usePushStatus).
      {
        name: 'toast-synced',
        path: '/settings',
        toast: { message: 'Synced with `origin/main`', type: 'success' },
      },
      // 3. Security-gate approval cards (the rich ApprovalCard): persistent, with
      // Allow once / Always allow / Deny; dismissing denies. These are the ONLY
      // shots that render an approval card — the simulated agents never park a
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
      // 3b. A specific write tool on an already-trusted server — amber WRITE badge,
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
      // 3c. A read-only tool call — quieter, teal READ badge.
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
      // 3d. An outbound WebFetch — NETWORK badge + URL, and the caption spelling
      // out that allowing trusts the whole host (every request, including POSTs).
      {
        name: 'agent-approvals-webfetch',
        path: '/settings',
        toast: {
          message: '',
          type: 'warning',
          actions: [
            { label: 'Allow once', variant: 'primary' },
            { label: 'Always allow', variant: 'primary' },
            { label: 'Deny', variant: 'danger' },
          ],
          approval: { kind: 'webfetch', target: 'docs.linear.app', agentName: 'Publish the changelog', agentId: 'agent-approval', projectId: 'sim-project', url: 'https://docs.linear.app/api/changelog' },
        },
      },
      // 3e. A blocked egress host: the agent's proxy hit a host on neither the
      // allow- nor block-list, so the connection is parked. Allow once opens it
      // for the session; Always allow adds it to the network allow-list.
      {
        name: 'agent-approvals-egress',
        path: '/settings',
        toast: {
          message: '',
          type: 'warning',
          actions: [
            { label: 'Allow once', variant: 'primary' },
            { label: 'Always allow', variant: 'primary' },
            { label: 'Deny', variant: 'danger' },
          ],
          approval: { kind: 'egress', target: 'telemetry.example.com', agentName: 'Add crash reporting', agentId: 'agent-approval', projectId: 'sim-project' },
        },
      },
      // 3f. An agent running in ANOTHER project: an amber "running in another
      // project" banner. Always allow is still offered (a remembered grant is
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
      // The keyboard-shortcuts help overlay, opened the way a user does — by
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
      // portal fix) — the bug where the dropdown didn't show when selected. The
      // branch list comes from the simulation server. Scoped to .max-w-4xl so it
      // opens the full-page form's selector, not the compact sidebar box's (both
      // carry the same title).
      { name: 'spawn-branch-selector', path: '/project/sim-project/', click: '.max-w-4xl button[title^="Base branch"]' },
      // The same dropdown opened from the compact spawn box in the top-left
      // sidebar (the mini form rendered on every project page). Scoped to the
      // `aside` so the click lands on the sidebar selector rather than the
      // full-page form's (both carry the same "Base branch" title). Verifies the
      // portal-rendered menu escapes the narrow sidebar's clipping too.
      { name: 'spawn-branch-selector-mini', path: '/project/sim-project/', click: 'aside button[title^="Base branch"]' },
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
      // The same seeded markdown draft with the whole spawn box selected. The
      // browser's selection band marks where the REAL (selectable) textarea text
      // sits, painted over the highlight backdrop — so the two layers can be
      // checked for drift at a glance. The acid test is the fenced ```code``` block
      // (and the blank line that hugs it): the selection rows must land exactly on
      // the highlighted rows, proving the inline-block code block stays glyph-aligned
      // with the textarea. tallSpawn shows the whole draft (block included) unscrolled.
      { name: 'spawn-markdown-selected', path: '/project/sim-project/', seedPrompt: MARKDOWN_DEMO_PROMPT, tallSpawn: true, selectSpawnText: true },
      // A large text paste turned into an attachment. Pasting a block over the
      // line threshold (a CI log here) doesn't fill the textarea — it lands as a
      // pasted-text-1.txt chip below it, the same chip the file uploads use, so
      // the typed task above stays readable. Documents the
      // attach-pasted-text-instead-of-inlining behavior on the full-page form.
      { name: 'spawn-pasted-text', path: '/project/sim-project/', seedPrompt: PASTED_TEXT_INSTRUCTION, pasteText: { text: PASTED_LOG_DEMO } },
      // The code-paste path: pasting an HTML snippet copied from an editor
      // attaches it on the first paste, and pasting it AGAIN inlines it for real
      // — wrapped in a ```html fence (the clipboard's language tag) so it renders
      // as a fenced code block in the highlight overlay. `again` fires both
      // pastes; tallSpawn enlarges the box so the whole fenced block shows.
      { name: 'spawn-pasted-code', path: '/project/sim-project/', pasteText: { text: PASTED_HTML_DEMO, vscodeMode: 'html', again: true }, tallSpawn: true },
      // The agent-detail prompt block rendering the same markdown: code/bold/
      // italic, an inline-code span that wraps, the tightened gap under the
      // metadata row, and the soft bottom fade as the tall prompt scrolls out of
      // view. Viewport-only to focus on the header + prompt (agent-md's seeded
      // prompt overflows the block's max height, so the fade is visible).
      { name: 'agent-markdown', path: '/project/sim-project/agent/agent-md', viewportOnly: true },
      // The tests panel (PLAN #68), now styled like the artifacts panel and living
      // in the diff viewer just below the "Changes" header. Pin Changes to the top,
      // then expand agent-2's single (failing) runner card by clicking its header —
      // its fixtures (simTestRunners) are a regression with two failing cases, so
      // the card shows the assertion messages failing-first.
      { name: 'tests-panel', path: '/project/sim-project/agent/agent-2', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)'] },
      // The "Group by result" view of the same runner: per-status sections
      // rendered as root tree nodes (failing open, skipped/passing collapsed)
      // with the everything-counted badges on the right, each open section's
      // tree indented under a lowlit guide line. Reached by expanding the
      // runner card, ticking the checkbox in the changes cog, then clicking
      // the Tests heading to dismiss the popup (it closes on outside click).
      { name: 'tests-panel-grouped', path: '/project/sim-project/agent/agent-2', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)', 'button[aria-label="View settings"]', 'label:has-text("Group by result")', 'h3:has-text("Tests")'] },
      // The same surface mid-run (agent-md is seeded as a running verdict): the
      // expanded card's live xterm build-log tail + progress bar + partial counts.
      { name: 'tests-panel-running', path: '/project/sim-project/agent/agent-md', scrollTo: 'Changes', clicks: ['button:has(svg.lucide-flask-conical)'] },
      // The indeterminate progress bar: agent-md's second runner ("eslint") is a
      // streamed run with no declared ::hydra:test:total::, so it has no fill
      // percentage — the bar is a full-width sliding "barber pole" of diagonal
      // stripes ("working, length unknown") rather than a partial fill. Expand
      // that card by its name so the striped bar sits under the live counts.
      { name: 'tests-panel-running-indeterminate', path: '/project/sim-project/agent/agent-md', scrollTo: 'Changes', clicks: ['button:has-text("eslint")'] },
      // The tests panel's info (i) card hovered with its heading pinned near the
      // top of the viewport: the tall card has no room above, so it opens DOWNWARD
      // with its arrow pointing up — the regression shot for the tooltip flip fix
      // (it used to be hard-coded to open upward and clipped off the top here). The
      // short viewport scrolls the terminal away so the Tests icon sits high on
      // screen, the condition that triggered the clip; testsInfo does the pin+hover.
      { name: 'tests-info-tooltip', path: '/project/sim-project/agent/agent-2', testsInfo: true, viewport: { width: 1280, height: 460 } },
      // The merge gate in the header (PLAN #68): the primary button always reads
      // "Merge" now; opening its split-button dropdown on agent-2's failing verdict
      // reveals the soft-gate warning plus the Force merge / Queue merge overrides.
      { name: 'tests-merge-gate', path: '/project/sim-project/agent/agent-2', viewportOnly: true, click: 'button[aria-label="Merge options"]' },
      // The force-merge confirm that names exactly what's being overridden — reached
      // by opening the merge dropdown and choosing Force merge.
      { name: 'tests-force-merge-confirm', path: '/project/sim-project/agent/agent-2', viewportOnly: true, clicks: ['button[aria-label="Merge options"]', 'button:has-text("Force merge")'] },
      // Auto-merge armed: agent-md (running + merge_when_green) shows the green
      // "merges when tests pass" metadata chip, and the merge button becomes the
      // green "Merges when tests pass" pill with its own Cancel button.
      { name: 'tests-merge-when-green', path: '/project/sim-project/agent/agent-md', viewportOnly: true },
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
      // armed) — clicking Merge offers "Merge now" (don't wait) or Queue merge, over
      // a blue running tile + a progress chip.
      { name: 'tests-merge-gate-dialog-running', path: '/project/sim-project/agent/agent-3', viewportOnly: true, click: 'button[aria-label="Merge"]' },
      // The merge gate when the AGENT (not the tests) isn't ready: agent-approval is
      // blocked asking you a question (needs_input), so clicking Merge warns "Agent
      // is waiting on you" and reuses the Force merge / Queue merge / Cancel choice —
      // Queue arms merge-when-green so it lands once the agent finishes and is green.
      { name: 'merge-agent-active-dialog', path: '/project/sim-project/agent/agent-approval', viewportOnly: true, click: 'button[aria-label="Merge"]' },
      // The agent + model picker dropdown, opened on the compact ("mini") spawn
      // box in the sidebar. The picker is a compact trigger (the active agent's
      // brand mark + the chosen model's short label) that opens a menu grouping
      // every agent type with its curated models nested underneath — so agent AND
      // model are chosen in one gesture (web/src/components/SpawnForm.tsx). This
      // shot documents the brand icons/accents and the nested model rows.
      // Captured on an agent page (not the project landing) so the sidebar's
      // compact box is the only spawn form on screen — the full-page box would
      // otherwise add a second, identical picker and make the click ambiguous.
      // viewportOnly: the menu is a fixed overlay anchored to the trigger at the
      // top-left, so the default viewport already frames both the box and menu.
      { name: 'spawn-agent-picker', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button[aria-label^="Agent and model:"]' },
      // The same picker with a model already selected (seeded Claude → Opus): the
      // compact trigger shows the model label beside the brand mark, and the open
      // menu shows the nested per-agent model rows with Opus checked. Documents
      // the model selector's selected state (the picked model is remembered per
      // agent type in StorageKeys.defaultModel and pins the CLI's --model at spawn).
      { name: 'spawn-model-picker', path: '/project/sim-project/agent/agent-1', viewportOnly: true, seedModel: { claude: 'opus' }, click: 'button[aria-label^="Agent and model:"]' },
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
      // A modified in-tree image: the diff viewer renders the artifacts panel's
      // before/after image differ (ImageDiffView) in place of "Binary file
      // changed", obeying the shared image-diff mode setting. Click the changed
      // image in the file list; side-by-side mode shows before and after at once
      // (the sim serves a different picture per ref, so they visibly differ).
      {
        name: 'repository-diff-image',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("diff-banner.png")'],
        imageDiffMode: 'side-by-side',
      },
      // An added in-tree image: only the after side exists, so the differ shows
      // the new image beside a "No image" before placeholder.
      {
        name: 'repository-diff-image-added',
        path: '/project/sim-project/repository',
        clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("diff-added.png")'],
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
      { name: 'repository-artifacts', path: '/project/sim-project/repository/main/.hydra/artifacts/screenshots', settleMasonry: true },
      // The same view with its "Show build log" toggle opened: the settled script's
      // persisted log (log_url) loads into an xterm terminal below the images —
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
      // view raw, and the view settings — the controls shown inline in the
      // desktop header — collapsed into one top-right menu.
      { name: 'repository-mobile-menu', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 390, height: 844 }, viewportOnly: true, click: 'button[aria-label="File actions"]' },
      // A branch diff drilled into on a phone: enter diff mode from the header
      // (compare → pick branch), then tap a changed file to open its diff
      // full-screen, with the back chevron + file path in the header. Documents
      // the phone drill-down for the compare view.
      { name: 'repository-mobile-diff', path: '/project/sim-project/repository', viewport: { width: 390, height: 844 }, viewportOnly: true, clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")', 'button:has-text("lines.go")'] },
      // Diff mode on a phone *before* picking a file: the changed-files list with
      // the base → head selectors in the header — documenting that the compact
      // selectors fit the narrow header without overflowing.
      { name: 'repository-mobile-diff-list', path: '/project/sim-project/repository', viewport: { width: 390, height: 844 }, viewportOnly: true, clicks: ['button:has(svg.lucide-git-compare)', 'button:has-text("hydra/add-line-numbers")'] },
      { name: 'repository-mobile-landscape', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 844, height: 390 }, viewportTag: 'mobile-landscape', viewportOnly: true },
      { name: 'repository-tablet', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 834, height: 1112 }, viewportTag: 'tablet', viewportOnly: true },
      { name: 'repository-tablet-landscape', path: '/project/sim-project/repository/main/internal/server/server.go', viewport: { width: 1112, height: 834 }, viewportTag: 'tablet-landscape', viewportOnly: true },
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
      // The per-agent Claude settings tab, opened by clicking the "Claude" pill in
      // the AgentSelector. Documents the agent-specific ConfigForm and, in
      // particular, the Claude-only "Fullscreen Rendering" toggle that sits between
      // the system pre-prompt and the sandbox policy (off by default — see
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
      // The agent detail header bar showing the user-facing title (e.g. "Add
      // renameable agent titles") in place of the stable ID, the adaptive action
      // toolbar (Merge / Mark as unread / Rename / Kill — shown with labels at this
      // width), and a status dot. Viewport-only so the shot focuses on the bar
      // rather than the terminal/diff below.
      { name: 'agent-title', path: '/project/sim-project/agent/agent-1', viewportOnly: true },
      // The inline rename in progress: clicking the title (it carries an I-beam to
      // signal it's editable) swaps it for an input seeded with the current title
      // (Enter saves via PATCH, Esc cancels). Target the Rename action by its
      // aria-label, which is the bare label "Rename" — the `title` attribute now
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
      // variant — red icon tile + a warning chip naming how many unmerged files
      // the worktree deletion will discard (count fetched in the background).
      { name: 'agent-kill-dialog', path: '/project/sim-project/agent/agent-1', viewportOnly: true, click: 'button[aria-label="Kill"]' },
      // The redesigned merge-conflict panel: agent-3's diff carries the
      // merge_conflict flag (simulation.go GetAgentDiff), so the Changes toolbar
      // shows a red "N conflict" button; clicking it opens the rich panel — red
      // icon tile + title/subtitle, an uppercase "Conflicting files" chip and the
      // dark "Resolving locally" command block, with Dismiss / Fix-with-agent in
      // the shared dialog-button styling. scrollTo brings the toolbar into view for
      // the click; the panel itself is a fixed, centered overlay.
      { name: 'merge-conflict-dialog', path: '/project/sim-project/agent/agent-3', viewportOnly: true, scrollTo: 'Changes', click: 'button:has-text("conflict")' },
      // The redesigned update-from-base confirmation: agent-2's diff trails its
      // base (behind_count) so the Changes toolbar shows an amber "N behind"
      // button; clicking it opens the rich panel — amber icon tile, a base→branch
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
      // agent-approvals-* shots above — the simulated agent no longer parks a live
      // approval, so the cards don't leak onto every simulated page.)
      { name: 'nested-folders', path: '/project/sim-project/agent/agent-3', scrollTo: 'Changes' },
      // The diff viewer's settings popup, opened from the gear in the sticky
      // "Changes" toolbar: the file-list view modes, the diff options (side-by-
      // side, ignore whitespace, one-file-at-a-time) and the image-diff comparison
      // modes. The nav's settings icon
      // is a <Link> (an <a>), so `button:has(svg.lucide-settings)` uniquely hits
      // the diff gear. scrollTo pins the toolbar to the top; viewport capture (the
      // popup is absolutely positioned just below the gear).
      {
        name: 'diff-settings',
        path: '/project/sim-project/agent/agent-1',
        scrollTo: 'Changes',
        viewport: { width: 1280, height: 1000 },
        click: 'button:has(svg.lucide-settings)',
      },
      // The sticky file header: each file's header now pins beneath the sticky
      // "Changes" toolbar while that file's diff scrolls under it — the same
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
      // desktop shapes). Scroll to the "Changes" header — the artifacts panel
      // renders directly below it — and use a taller viewport so the wrapped
      // before/after cards fit in one capture. Meta: a screenshot of the diff
      // page showing artifact before/after screenshots.
      //
      // The diff viewer offers four image-diff comparison modes (a setting in the
      // diff viewer; see web/src/components/ArtifactsPanel.tsx ImageDiffView). We
      // capture the artifacts panel once per mode so each option is documented:
      //   side-by-side — before and after shown next to each other ('artifacts')
      //   ab           — before/after stacked, click to flip; a "Highlight" tab
      //                  paints the changed pixels magenta (the app's default mode)
      //   slider       — draggable divider with a hard cut between before/after
      //   onion        — before/after blended via an opacity slider
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
      // that every diff mode works there — not just a static image.
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
      // a spinner while generating, etc.) until clicked open — the default, opt-in
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
      // enabled — documents the overlay (and its pixel-for-pixel alignment with
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
      // active style and the slider sits mid-track) — at that gate the near-
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
      // side rendered, so the card stays "ready" — the before terminal is
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
      //   side-by-side   — the Before / After clips next to each other + transport
      //   ab + Highlight — the per-frame pixel diff (changed pixels painted magenta),
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
      // ── Mobile / small-screen layout (MOBILE_PLAN.md Phase 1) ───────────────
      // The same UI captured at phone width (390×844) to document the responsive
      // work: the sidebar collapses into a hamburger-toggled off-canvas drawer,
      // the header/metadata rows wrap, padding tightens, and the diff drops its
      // file-list sidebar for a full-width unified diff. The width (<700) makes
      // each of these tag itself viewport::mobile (see the sidecar block below),
      // so a reviewer can filter the panel down to just the small-screen shots.
      //
      // The project home at phone width: the full-page spawn form fills the
      // screen, the top bar is gone, and the sidebar is collapsed by default —
      // so only the small floating "show sidebar" button sits top-left.
      { name: 'mobile-home', path: '/project/sim-project/', viewport: { width: 390, height: 844 } },
      // The sidebar opened: clicking the floating reveal button slides the
      // sidebar in over a dimmed backdrop. It now carries the whole app chrome —
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
      // "⋯" menu rather than truncating the name — opened here to show the remaining
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
      // The sidebar opened as an overlay (still below the lg breakpoint) so it
      // doesn't squeeze the short content underneath — header, list, and footer
      // all visible at once.
      {
        name: 'mobile-landscape-menu',
        path: '/project/sim-project/agent/agent-1',
        viewport: { width: 844, height: 390 },
        viewportTag: 'mobile-landscape',
        viewportOnly: true,
        click: 'button[aria-label="Show sidebar"]',
      },

      // ── Tablet portrait (834×1112) ──────────────────────────────────────────
      // A tablet upright: below the lg breakpoint, so the sidebar is an overlay
      // (collapsed by default) and the content spans the full width — no more
      // cramped permanent two-column split.
      { name: 'tablet-home', path: '/project/sim-project/agent/agent-1', viewport: { width: 834, height: 1112 }, viewportTag: 'tablet', viewportOnly: true },
      // The sidebar opened over the content (overlay + backdrop).
      {
        name: 'tablet-menu',
        path: '/project/sim-project/agent/agent-1',
        viewport: { width: 834, height: 1112 },
        viewportTag: 'tablet',
        viewportOnly: true,
        click: 'button[aria-label="Show sidebar"]',
      },

      // ── Tablet landscape (1112×834) ─────────────────────────────────────────
      // A tablet on its side: at/above the lg breakpoint, so the sidebar is the
      // usual persistent in-flow column — this is the clearest look at the new
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
      // that used to live in the top bar; capture its header region to document it.
      { name: 'settings-appearance', path: '/project/sim-project/settings', viewport: { width: 1280, height: 900 }, viewportOnly: true },
      // The desktop layout with the sidebar collapsed (Ctrl+. / the header
      // button): full-width content + the floating reveal button.
      { name: 'desktop-collapsed', path: '/project/sim-project/agent/agent-1', click: 'button[aria-label="Hide sidebar"]', viewportOnly: true },
      // The artifacts panel at phone width: the masonry clamps to a single column
      // (no column is allowed below BASE_MIN_COL_PX), so every tile's aspect-ratio
      // span collapses and the width-driven before/after tiles stack full-width —
      // the panel stays usable on a narrow screen. showArtifacts expands the card so
      // the images (not just the collapsed header) are captured.
      { name: 'mobile-artifacts', path: '/project/sim-project/agent/agent-1', viewport: { width: 390, height: 844 }, scrollTo: 'Changes', imageDiffMode: 'ab', showArtifacts: true },
    ]
    // Capture every page in both themes. Dark mode has its own colours (e.g.
    // diff add/remove backgrounds), so a light-only render would miss visual
    // changes that only show up in dark mode. The app stores its theme
    // preference in localStorage (StorageKeys.themeMode) and toggles a `dark`
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
    // but stays a modest fraction of it (roughly a quarter of the cores, clamped
    // to a small range) so capturing the set doesn't saturate the machine — each
    // headless context is a full Chromium render and a context-per-core pool
    // pegs every CPU. Override with HYDRA_SHOT_CONCURRENCY to trade CPU for speed.
    // The clamp bounds peak memory and avoids starving renders of CPU; the
    // captured pixels are per-context deterministic regardless of how many run in
    // parallel, so this doesn't affect the diff-hash reproducibility.
    // HYDRA_SHOT_ONLY (comma-separated page names) narrows the run to a few shots
    // while iterating locally — the full set is slow to capture. Unset ⇒ all pages.
    const only = process.env.HYDRA_SHOT_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)
    const tasks = pages
      .filter((pg) => !only || only.includes(pg.name))
      .flatMap((pg) => (pg.themes ?? themes).map((theme) => ({ pg, theme })))
    const totalShots = tasks.length
    const cpuCount = (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) || 8
    const defaultConcurrency = Math.min(Math.max(Math.floor(cpuCount / 4), 2), 4)
    const concurrency = Math.max(1, Math.min(Number(process.env.HYDRA_SHOT_CONCURRENCY) || defaultConcurrency, totalShots))
    let done = 0
    let nextTask = 0

    const captureShot = async (pg: (typeof pages)[number], theme: (typeof themes)[number]) => {
        const suffix = theme === 'dark' ? '-dark' : '-light'
        // Capture phone shots at 2x so they stay crisp when the diff grid gives them a
        // generous (logical) width; desktop shots stay at 1x (they're already wide
        // enough). The dpi is written into the .meta sidecar (below) so the grid sizes
        // a tile by its LOGICAL width (physical px ÷ dpi) — a 2x phone shot lays out the
        // same as a 1x one, just sharper. "Mobile" matches the viewport tag derived
        // below: an explicit mobile* viewportTag, else a narrow capture width.
        const isMobile = pg.viewportTag ? pg.viewportTag.startsWith('mobile') : (pg.viewport?.width ?? 1280) < 700
        const dpi = isMobile ? 2 : 1
        const ctx = await browser.newContext({
          viewport: pg.viewport ?? { width: 1280, height: 800 },
          deviceScaleFactor: dpi,
          colorScheme: theme,
        })
        // Pin Date/now to a fixed instant (matching the server's simNow) so the
        // UI's "elapsed"/"X ago" labels are byte-stable across the two renders.
        // setFixedTime only freezes the wall clock — timers and requestAnimationFrame
        // keep running, so the settle() rAF wait and the setTimeout freeze below are
        // unaffected.
        await ctx.clock.setFixedTime(SIM_NOW)
        // Seed the theme preference before any app code runs.
        await ctx.addInitScript(({ key, mode }) => {
          try {
            localStorage.setItem(key, mode)
          } catch {
            // ignore storage failures
          }
        }, { key: StorageKeys.themeMode, mode: theme })
        // Emulate a touch device's coarse pointer by forcing the fine-pointer
        // media query false, so keyboard-only chrome (shortcut hints) hides like it
        // does on a real phone. Delegates every other query to the real matchMedia
        // so theme + breakpoint detection is unaffected.
        if (pg.coarsePointer) {
          await ctx.addInitScript(() => {
            const orig = window.matchMedia.bind(window)
            window.matchMedia = ((q: string) =>
              typeof q === 'string' && q.includes('pointer: fine')
                ? {
                    matches: false,
                    media: q,
                    onchange: null,
                    addEventListener() {},
                    removeEventListener() {},
                    addListener() {},
                    removeListener() {},
                    dispatchEvent() { return false },
                  }
                : orig(q)) as typeof window.matchMedia
          })
        }
        // Seed the diff viewer's image-diff mode so the artifacts panel renders
        // before/after pairs in the requested comparison style.
        if (pg.imageDiffMode) {
          await ctx.addInitScript(({ key, mode }) => {
            try {
              localStorage.setItem(key, mode)
            } catch {
              // ignore storage failures
            }
          }, { key: StorageKeys.diffImageMode, mode: pg.imageDiffMode })
        }
        // Seed the repository diff's one-file-at-a-time preference so the
        // all-files-stacked view can be captured (the default is one file).
        if (pg.repoDiffSingleFile !== undefined) {
          await ctx.addInitScript(({ key, single }) => {
            try {
              localStorage.setItem(key, String(single))
            } catch {
              // ignore storage failures
            }
          }, { key: StorageKeys.repoDiffSingleFile, single: pg.repoDiffSingleFile })
        }
        // Seed the artifact tag filter so the panel renders with a filter applied.
        // The key comes from the app's shared artifactTagFilterKey builder; these
        // pages are all the sim project's agent-1.
        if (pg.tagFilter) {
          await ctx.addInitScript(({ key, f }) => {
            try {
              localStorage.setItem(
                key,
                JSON.stringify({ scoped: f.scoped ?? {}, free: f.free ?? [], changeThreshold: f.changeThreshold ?? 0 }),
              )
            } catch {
              // ignore storage failures
            }
          }, { key: artifactTagFilterKey(SIM_PROJECT, SIM_AGENT), f: pg.tagFilter })
        }
        // Seed an unsent spawn-prompt draft so the spawn box renders pre-filled,
        // for both layouts; the keys come from the app's shared promptDraftKey
        // builder. These pages are all the sim project.
        if (pg.seedPrompt) {
          await ctx.addInitScript(({ fullKey, compactKey, text }) => {
            try {
              localStorage.setItem(fullKey, text)
              localStorage.setItem(compactKey, text)
            } catch {
              // ignore storage failures
            }
          }, { fullKey: promptDraftKey(SIM_PROJECT, false), compactKey: promptDraftKey(SIM_PROJECT, true), text: pg.seedPrompt })
        }
        // Seed the remembered agent→model map so the picker shows a selected model.
        if (pg.seedModel) {
          await ctx.addInitScript(({ key, map }) => {
            try { localStorage.setItem(key, JSON.stringify(map)) } catch { /* ignore */ }
          }, { key: StorageKeys.defaultModel, map: pg.seedModel })
        }
        // Capture-only: widen the sidebar so the compact spawn box has more
        // horizontal room and its seeded markdown wraps less / reads better.
        // The width is React state seeded from this localStorage key (the app's
        // shared StorageKeys.sidebarWidth; __root.tsx clamps it to <=600 and
        // defaults to 264), so seeding it before boot is stable across re-renders.
        // The app's default width is unchanged outside this shot.
        if (pg.tallSpawn) {
          await ctx.addInitScript((key) => {
            try { localStorage.setItem(key, '380') } catch { /* ignore */ }
          }, StorageKeys.sidebarWidth)
        }
        if (pg.narrowSidebar) {
          await ctx.addInitScript((key) => {
            try { localStorage.setItem(key, '170') } catch { /* ignore */ }
          }, StorageKeys.sidebarWidth)
        }
        await ctx.addInitScript((opts) => {
          // The "Trust this project?" modal (web/src/components/TrustProjectModal.tsx)
          // only appears while *adding* a project — never on open — so the
          // simulated projects (already registered) never trigger it during the
          // capture flow. No pre-trust seeding is needed.
          // Enable the toast harness (window.__hydraToast) so the `toast` page
          // option can drive the toast store. Dormant in the app unless set.
          try { window.localStorage.setItem(opts.harnessKey, '1') } catch { /* ignore */ }
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
        }, { harnessKey: StorageKeys.toastHarness })
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
        if (pg.selectSpawnText) {
          // Focus the full-page spawn textarea and select all of it, so the capture
          // shows the browser's selection band (the real text positions) over the
          // highlight backdrop. Focus is required for the vivid active-selection
          // colour (an unfocused textarea greys its selection out). Scoped to the
          // .max-w-4xl form so it hits the full-page box, not the sidebar's compact one.
          await page.evaluate(() => {
            const ta = document.querySelector('.max-w-4xl textarea') as HTMLTextAreaElement | null
            if (ta) {
              ta.focus()
              ta.setSelectionRange(0, ta.value.length)
            }
          })
          await settle(page)
        }
        if (pg.pasteText) {
          // Stub the upload endpoint so the pasted-text chip leaves its
          // "uploading" state at a fixed point (the response path/filename are
          // unused for the chip label — the form names it pasted-text-N.txt).
          await page.route('**/uploads/**', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ path: '/sim/.hydra/local/uploads/pasted-text-1.txt', filename: 'pasted-text-1.txt' }),
            }),
          )
          // Fire a real paste (a populated DataTransfer on a 'paste' event) into
          // the full-page spawn textarea, so the form's onPaste runs exactly as
          // it does for a user. `again` fires it twice to exercise the re-paste
          // (inline) path; `vscodeMode` tags the clipboard as code.
          await page.evaluate(({ text, vscodeMode, again }) => {
            const ta = document.querySelector('.max-w-4xl textarea') as HTMLTextAreaElement | null
            if (!ta) return
            ta.focus()
            const fire = () => {
              const dt = new DataTransfer()
              dt.setData('text/plain', text)
              if (vscodeMode) dt.setData('vscode-editor-data', JSON.stringify({ mode: vscodeMode }))
              ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
            }
            fire()
            if (again) fire()
          }, pg.pasteText)
          if (pg.pasteText.again) {
            // The second paste inlines the block into the textarea (fenced when
            // it's code) — wait until the fence has landed in the box.
            await page.waitForFunction(() =>
              ((document.querySelector('.max-w-4xl textarea') as HTMLTextAreaElement | null)?.value ?? '').includes('```'),
            )
          } else {
            // The first paste attaches it — wait until the chip has rendered and
            // its upload spinner has cleared (scoped to the full-page form so a
            // stray spinner elsewhere can't satisfy it early).
            await page.waitForFunction(() => {
              const form = document.querySelector('.max-w-4xl')
              if (!form) return false
              const hasChip = Array.from(form.querySelectorAll('span')).some((s) => s.textContent === 'pasted-text-1.txt')
              return hasChip && !form.querySelector('svg.lucide-loader-circle')
            })
          }
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
          // none is still uploading. The "still uploading" marker is an
          // AttachmentChips LoaderCircle; check only within the chips' shared
          // container (the View buttons' grandparent) so an unrelated spinner
          // elsewhere on the page — e.g. a running test-verdict chip in the
          // sidebar — can't keep it from settling. (The chips render outside the
          // .max-w-4xl form wrapper, so a form-scoped check would never see them.)
          await page.waitForFunction(
            (n) => {
              const views = Array.from(document.querySelectorAll('[aria-label^="View "]'))
              if (views.length !== n) return false
              const row = views[0]?.parentElement?.parentElement ?? document.body
              return !row.querySelector('svg.lucide-loader-circle')
            },
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
        if ((pg.imageDiffMode || pg.expandArtifact) && pg.path.includes('/agent/')) {
          // The artifacts panel populates from a WebSocket snapshot, which (unlike
          // the HTTP fetches the goto's networkidle waits for) isn't tracked by
          // networkidle. Wait for the always-present "screenshots" card so the
          // panel is rendered before we capture it. Only the agent diff page has an
          // artifacts panel — the repository branch-compare diff also reads
          // imageDiffMode (for in-tree image diffs) but has no such card to wait on.
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
        if (pg.searchArtifacts) {
          // Type a query into the artifacts panel's search box (the panel exists
          // once the WS snapshot has populated the "screenshots" card).
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('screenshots')),
          )
          await page.fill('input[placeholder="search"]', pg.searchArtifacts)
          await settle(page)
        }
        if (pg.click) {
          // Open a popover (e.g. the branch selector) so the capture documents it.
          await page.click(pg.click)
          await settle(page)
        }
        if (pg.hover) {
          // Hover an element to open its hover-only tooltip so the capture documents
          // it — e.g. the "Merge queued" pill's explanation. The tooltip must show
          // synchronously on hover (delay 0): a post-hover wait would let the layout
          // settle and drift the element out from under Playwright's fixed cursor,
          // firing mouseleave and dismissing the (grace-less) dark hint.
          await page.locator(pg.hover).first().hover()
          await settle(page)
        }
        if (pg.pressKey) {
          // Blur the autofocused field (e.g. the spawn textarea) so the chord hits
          // the window-level shortcut handler instead of being typed into it, then
          // press it — used to open the keyboard-shortcuts overlay via `?`.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          await page.keyboard.press(pg.pressKey)
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
        if (pg.stickFile) {
          // Pin the named file's header beneath the sticky "Changes" toolbar, with
          // part of its body scrolled under it, to document the sticky file header.
          // The artifacts panel populates over a WebSocket (not tracked by
          // networkidle) and sits above the diff, so wait for it first — otherwise
          // a late layout shift would move the file and the scroll would miss.
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('screenshots')),
          )
          await settle(page)
          await page.evaluate(({ name, gap }) => {
            // The file header is the FileDiff card's sticky, rounded-t header; the
            // artifact/test card headers share those classes, so match on the path
            // text to pick the right one. Scroll its natural top `gap` px above the
            // container top so it's pinned (stuck) with that much body scrolled under.
            const header = Array.from(document.querySelectorAll('div.sticky.rounded-t-lg')).find(
              (h) => h.textContent?.includes(name),
            ) as HTMLElement | undefined
            const cont = header?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (header && cont) {
              const offset = header.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              cont.scrollTop = offset + gap
            }
          }, { name: pg.stickFile, gap: 150 })
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
          // for them to be attached, not visible: the Highlight view keeps its
          // videos hidden (only the diff canvas shows), so a visibility wait would
          // time out there.
          await page.waitForSelector('video', { state: 'attached' })
          await settle(page)
          // Seek every video to the shared time and wait for a real decoded frame
          // to land. play() is a no-op (init script), so the pair stays paused on
          // the seeked frame, which is identical across renders (byte-stable).
          await ensureVideosPainted(page, pg.videoDiff.seek)
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
          if (pg.videoDiff.highlight) {
            // Switch the video to its Highlight tab (the magenta per-frame pixel
            // diff, which now lives inside the Before/After mode). The button sits
            // in the .webm row's tab strip; find it within that file's card.
            await page.evaluate(() => {
              const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent?.trim() === 'loader-animation.webm')
              const row = span?.closest('div.rounded-lg') as HTMLElement | null | undefined
              const btn = row && Array.from(row.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Highlight')
              ;(btn as HTMLButtonElement | undefined)?.click()
            })
            await settle(page)
          }
          // The Highlight view redraws its pixel-diff canvas on a throttled rAF
          // loop; give it real time (playwright timers, not the page's frozen
          // setTimeout) to draw the seeked frame at least once. Once drawn the
          // pixels are identical every iteration (the pair is paused), so the
          // shot stays byte-stable.
          await page.waitForTimeout(400)
          await settle(page)
        }
        if (pg.showArtifacts) {
          // Expand the ready "screenshots" card so its before/after masonry is
          // visible (cards default to collapsed). The card only exists once the
          // artifacts WS snapshot has populated it, so wait for its header first.
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('screenshots')),
          )
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('screenshots'))
            btn?.click()
          })
          await settle(page)
          // Eager-load every tile image: the masonry sizes each column from the
          // images' natural dimensions, so they must be fully decoded before it
          // lays out — and lazy images below the fold would otherwise never load
          // (and a half-loaded layout wouldn't be byte-reproducible). The tiles
          // carry data-mkey (the masonry's per-tile key); scope to their <img>s.
          await page.evaluate(() => {
            document.querySelectorAll<HTMLImageElement>('[data-mkey] img').forEach((i) => { i.loading = 'eager' })
          })
          await page.waitForFunction(() => {
            const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-mkey] img'))
            return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalHeight > 0)
          })
          // Let the masonry's ResizeObserver-driven layout settle on the now-final
          // image heights (real timer, not the page's frozen setTimeout). The final
          // layout is deterministic, so a fixed wait past it stays byte-stable.
          await page.waitForTimeout(500)
          await settle(page)
          // Force every .webm tile to decode + paint a stable frame (else the tile
          // shows through to its transparent checkerboard backdrop, or — the bug
          // that named this branch — lands a frame off run to run). Same fixed
          // VIDEO_SEEK as the dedicated shots so every webm tile across the suite
          // shows the identical frame; ensureVideosPainted fully buffers first,
          // which is what makes this below-the-fold row's seek reproducible. A
          // mid-clip frame (not 0) keeps the slider/onion before/after visibly
          // different, which is the whole point of those overlay-mode shots.
          await ensureVideosPainted(page, VIDEO_SEEK)
          await settle(page)
          // Pin the "screenshots" card to the top of the scroll container so its
          // expanded grid is the focus (same sticky-aware offset as expandArtifact).
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('screenshots'))
            const card = btn?.closest('div.rounded-lg') as HTMLElement | null | undefined
            const cont = card?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (card && cont) {
              const offset = card.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              cont.scrollTop = offset - 96
            }
          })
          await settle(page)
        }
        if (pg.openArtifactImage) {
          // Click the first before/after artifact image to open it in the
          // fullscreen lightbox. showArtifacts has expanded the card and decoded
          // its tiles, so the masonry images exist; in side-by-side mode each tile
          // is a plain <img> inside a click-to-open button, so a plain click (no
          // drag) opens the overlay. Only real images carry an <img> (absent sides
          // render a placeholder div), so the first match is always openable.
          await page.click('[data-mkey] img')
          // Wait for the lightbox caption to show the pixel dimensions ("W × H"),
          // which only render after the lightbox image's onLoad fires — so the
          // capture always includes them (same guard as the spawn-box lightbox).
          await page.waitForFunction(() =>
            !!document.querySelector('figure figcaption')?.textContent?.includes('×'),
          )
          await settle(page)
          if (pg.lightboxMode) {
            // Switch the in-lightbox comparator to another mode via its selector
            // (button text === the mode label), then let the new layers decode.
            await page.click(`figure button:text-is("${pg.lightboxMode}")`)
            await settle(page)
          }
          if (pg.lightboxZoom) {
            // Magnify the comparator (ZoomPan) so the minimap + "Reset view" chrome
            // is visible. Hover the frame centre and wheel in; the zoom is toward the
            // cursor, so a fixed wheel amount over a fixed-layout frame is reproducible.
            const frame = await page.locator('figure .overflow-hidden').first().boundingBox()
            if (!frame) throw new Error('lightbox zoom frame not found')
            await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
            for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -180)
            // The minimap + Reset only mount once magnified; wait for the Reset button.
            await page.waitForFunction(() =>
              Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('Reset view')),
            )
            await settle(page)
          }
        }
        if (pg.highlightArtifacts) {
          // Turn on the artifacts panel's global "Highlight" toggle (in the header,
          // shown in A/B mode) so the magenta pixel-diff overlay (DiffCanvas) is
          // painted over every changed image tile. Highlight is a single panel-wide
          // control now — driving all tiles via context — not a per-tile checkbox, so
          // there's one labelled "Highlight" checkbox to tick rather than one per tile.
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('label')).some((l) => l.textContent?.trim() === 'Highlight'),
          )
          await page.evaluate(() => {
            const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.trim() === 'Highlight')
            const cb = label?.querySelector<HTMLInputElement>('input[type=checkbox]')
            if (cb && !cb.checked) cb.click()
          })
          // Each ticked tile mounts a DiffCanvas that loads both images and paints
          // its overlay asynchronously, clearing the canvas's opacity-0 once ready.
          // Wait for every overlay canvas to finish so the magenta diff is fully
          // drawn before the capture — otherwise a half-painted (or still-blank)
          // overlay would itself read as a visual change. Once painted, the overlay
          // is a deterministic pixel compare of the two images, so it renders the
          // same every time.
          await page.waitForFunction(() => {
            const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-mkey] canvas'))
            return canvases.length > 0 && canvases.every((c) => !c.classList.contains('opacity-0'))
          })
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
        if (pg.testsInfo) {
          // Pin the "Tests" heading near the TOP of its scroll container so the
          // (i) icon has almost no room above it: the card must flip downward
          // rather than open up and clip off-screen. (The sticky "Changes"
          // toolbar sits just above, so a small offset keeps the heading visible
          // under it near the viewport top.)
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('h3')).some((h) => h.textContent?.trim() === 'Tests'),
          )
          await page.evaluate(() => {
            const h3 = Array.from(document.querySelectorAll('h3')).find((e) => e.textContent?.trim() === 'Tests')
            const cont = h3?.closest('.overflow-auto') as HTMLElement | null | undefined
            if (h3 && cont) {
              const offset = h3.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop
              // Leave just ~56px above the heading (room for the sticky Changes
              // toolbar), so the icon ends up high in the viewport.
              cont.scrollTop = offset - 56
            }
          })
          await settle(page)
          // Hover the info icon next to the "Tests" heading (its InfoTooltip Info
          // svg carries cursor-help) so React's onMouseEnter opens the card.
          await page
            .locator('xpath=//h3[normalize-space()="Tests"]/parent::*//*[name()="svg" and contains(@class,"cursor-help")]')
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
        if (pg.settleMasonry) {
          // Eager-load every masonry tile image (the layout sizes columns from the
          // images' natural dimensions) and wait for them to decode, then let the
          // ResizeObserver-driven layout settle — so the width-driven grid is
          // byte-reproducible. No-op when the page has no masonry tiles.
          const hasTiles = await page.evaluate(() => document.querySelectorAll('[data-mkey] img').length > 0)
          if (hasTiles) {
            await page.evaluate(() => {
              document.querySelectorAll<HTMLImageElement>('[data-mkey] img').forEach((i) => { i.loading = 'eager' })
            })
            await page.waitForFunction(() => {
              const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-mkey] img'))
              return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalHeight > 0)
            }).catch(() => { /* tolerate a stray never-loading image */ })
            await page.waitForTimeout(500)
            await settle(page)
          }
        }
        if (pg.revealSelector) {
          // Bring an element inside an inner scroll container into the viewport's
          // middle so a viewport capture shows it (the page body itself doesn't
          // scroll, so fullPage can't reach it). The element isn't sticky, so
          // scrollIntoView behaves — unlike the sticky section headings scrollTo
          // handles by hand.
          await page.evaluate((sel) => {
            document.querySelector(sel)?.scrollIntoView({ block: 'center' })
          }, pg.revealSelector)
          await settle(page)
        }
        if (pg.toast) {
          // Clear any toast the app popped on load, then render exactly this one,
          // and wait for it to paint before capturing. Persistent (duration 0) so
          // it can't expire mid-capture.
          await page.evaluate((spec) => {
            const h = (window as unknown as { __hydraToast: { reset: () => void; show: (s: unknown) => void } }).__hydraToast
            h.reset()
            h.show(spec)
          }, pg.toast)
          await page.waitForSelector('[role="status"], [role="alertdialog"]')
          await settle(page)
        }
        const out = join(OUT, `${pg.name}${suffix}.png`)
        // Scrolled pages, the lightbox (a fixed, viewport-filling overlay) from
        // either the spawn box (attachImages) or an artifact tile (openArtifactImage),
        // header-focused shots and the hovered info tooltip (a fixed portal)
        // capture the viewport; others capture the full page.
        await captureWithRetry(page, { path: out, fullPage: !pg.scrollTo && !pg.attachImages && !pg.openArtifactImage && !pg.viewportOnly && !pg.artifactInfo && !pg.testsInfo && !pg.videoDiff && !pg.revealSelector && !pg.toast })
        // Emit the tag sidecar (<file>.png.meta, {"tags":[...]}) that the diff
        // viewer reads (internal/artifacts readTagsSidecar). theme + viewport +
        // section are scoped "category::value" labels — the viewer keeps one
        // value per category and offers each as a single-select filter — so a
        // reviewer can, e.g., show only the dark-mode repository shots. The
        // viewport axis is the page's explicit viewportTag when set (needed for
        // landscape/tablet sizes, which width alone can't classify), otherwise
        // derived from the capture width: narrow → mobile, everything wider →
        // desktop.
        const viewport = pg.viewportTag ?? ((pg.viewport?.width ?? 1280) < 700 ? 'mobile' : 'desktop')
        const tags = [`theme::${theme}`, `viewport::${viewport}`, `section::${sectionFor(pg.name)}`]
        // Record dpi only when non-default (the 2x phone shots) — Hydra treats an
        // absent dpi as 1, so desktop sidecars stay byte-identical to before.
        writeFileSync(`${out}.meta`, JSON.stringify(dpi !== 1 ? { tags, dpi } : { tags }))
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
    //
    // A single failing shot must NOT abort the whole run: this command is a
    // diff-viewer artifact, and a thrown error exits non-zero, which Hydra caches
    // as a failed generation — so ONE flaky page would blank the entire artifacts
    // panel for the head. Instead we catch per-page, record the failure, and keep
    // going so every other shot still renders; the run only fails hard (rethrows)
    // if EVERY shot failed (a real, total breakage). Failures are logged loudly
    // and summarised at the end so a broken page is still obvious in the build log.
    const failures: string[] = []
    const worker = async () => {
      while (nextTask < tasks.length) {
        const { pg, theme } = tasks[nextTask++]
        const suffix = theme === 'dark' ? '-dark' : '-light'
        try {
          await captureShot(pg, theme)
        } catch (err) {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
          failures.push(`${pg.name}${suffix}: ${msg}`)
          console.error(`✗ screenshot failed: ${pg.name}${suffix}: ${msg}`)
        }
      }
    }
    progress(`capturing ${totalShots} screenshots (${concurrency} at a time)`)
    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    // Record a real animated UI element to a lossless .webm so the screenshots
    // artifact also exercises the video diff viewer (web/src/components/
    // VideoDiffView.tsx) — the moving-picture twin of the PNG shots.
    //
    // The diff viewer compares video by per-frame decoded-pixel hashes (ffmpeg
    // `-f framemd5`; see internal/artifacts videoFrameHashes), so what must be
    // stable is the decoded FRAMES — container metadata/timestamps are ignored,
    // and the .webm need not be byte-identical. We still make the frames
    // deterministic so a re-render never reads "modified": we DON'T let the CSS
    // animation free-run on the wall clock (we kill all CSS animation and drive
    // the motion ourselves with an explicit per-frame transform), and the
    // libvpx-vp9 -lossless encode is muxed with -flags/-fflags +bitexact to drop
    // the muxer's wall-clock date/version strings (yuv444p keeps full chroma).
    const ffmpegBin = ffmpegStatic as unknown as string
    // Record the sidebar's status dot gently pulsing while an agent is "running",
    // together with its small detail row (type pill, status badge, live-activity
    // line) — the moving twin of the static sidebar shot. We clip tightly to just
    // the one agent row.
    //
    // The pulse is a CSS keyframe (animate-status-pulse: a scale + opacity
    // breathe). Per the determinism note above we kill every CSS animation and
    // drive the dot's scale/opacity ourselves per frame, mirroring the keyframe
    // with a raised-cosine pulse (1 → peak → 1 over the cycle), so the frames are
    // deterministic. 30fps gives a smooth breathe; 42 frames = one 1.4s cycle,
    // matching the CSS animation's real duration. Cost is only capture time (one
    // screenshot per frame); determinism is unaffected by fps.
    const PULSE_FPS = 30
    const PULSE_FRAMES = 42 // one 1.4s breathe cycle at 30fps
    const recordStatusDot = async (theme: (typeof themes)[number]) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: theme })
      await ctx.clock.setFixedTime(SIM_NOW)
      await ctx.addInitScript(({ key, mode }) => { try { localStorage.setItem(key, mode) } catch { /* ignore */ } }, { key: StorageKeys.themeMode, mode: theme })
      const page = await ctx.newPage()
      try {
        await page.goto(base + '/project/sim-project/', { waitUntil: 'domcontentloaded' })
        // The first sidebar agent (agent-md) is "running" (see simulation.go
        // ListAgents), so its status dot pulses green and its detail row carries a
        // live-activity line — exactly the "status icon + small agent detail" we want.
        const row = page.locator('aside button:has-text("Add inline markdown rendering")').first()
        await row.waitFor()
        await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready })
        // Kill every CSS animation/transition so the pulse doesn't free-run on the
        // wall clock; we set the dot's scale/opacity explicitly per frame below.
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' })
        const box = await row.boundingBox()
        if (!box) throw new Error('sidebar agent row has no bounding box')
        // Clip tightly to the row, rounded to an even-sided box.
        const clip = {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width / 2) * 2,
          height: Math.round(box.height / 2) * 2,
        }
        const tmp = mkdtempSync(join(tmpdir(), 'hydra-pulse-'))
        for (let i = 0; i < PULSE_FRAMES; i++) {
          const p = i / PULSE_FRAMES
          const e = (1 - Math.cos(2 * Math.PI * p)) / 2 // raised cosine: 0 → 1 → 0
          const scale = 1 + 0.35 * e
          const opacity = 1 - 0.35 * e
          await row.evaluate((el, s) => {
            const dot = el.querySelector('.animate-status-pulse') as HTMLElement | null
            if (dot) {
              dot.style.transform = `scale(${s.scale})`
              dot.style.opacity = String(s.opacity)
            }
          }, { scale, opacity })
          // Commit the inline style before the shot (two rAFs, like settle()).
          await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
          await page.screenshot({ path: join(tmp, `f${String(i).padStart(3, '0')}.png`), clip })
        }
        const out = join(OUT, `status-dot-pulse-${theme}.webm`)
        const r = spawnSync(ffmpegBin, [
          '-y', '-nostdin', '-loglevel', 'error',
          '-framerate', String(PULSE_FPS), '-i', join(tmp, 'f%03d.png'),
          '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv444p',
          '-g', String(PULSE_FPS), '-threads', '1', '-an',
          '-flags', '+bitexact', '-fflags', '+bitexact',
          out,
        ], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr}`)
        writeFileSync(`${out}.meta`, JSON.stringify({ tags: [`theme::${theme}`, 'section::agent'] }))
        console.log(`wrote ${out}`)
      } finally {
        await ctx.close()
      }
    }
    progress('recording status-dot video')
    for (const theme of themes) await recordStatusDot(theme)

    // Summarise any per-page failures. We exit 0 as long as at least one shot
    // rendered, so the artifacts panel still shows everything that worked (a
    // failed run is cached as an error and would otherwise show nothing); only a
    // total wipe-out (every shot failed) is treated as a hard failure.
    if (failures.length > 0) {
      console.error(`\n${failures.length} screenshot(s) failed:`)
      for (const f of failures) console.error(`  ✗ ${f}`)
      if (done === 0) throw new Error('every screenshot failed to render')
      console.error(`(continuing — ${done} shot(s) rendered; the artifacts panel shows those)`)
    }
  } finally {
    await browser.close()
  }
} finally {
  server.kill('SIGTERM')
  // Remove the throwaway binary dir (hydra-shot-*). Without this every artifact
  // run leaks a ~30MB dir into the host's /tmp — they pile up fast since this
  // runs on both sides of every screenshot comparison. Safe to unlink even
  // though the server still holds the binary open (Linux/macOS unlink-on-use).
  rmSync(binDir, { recursive: true, force: true })
}

progress('done')
