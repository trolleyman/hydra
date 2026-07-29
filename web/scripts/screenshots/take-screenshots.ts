/// <reference types="node" />
//
// Diff-viewer artifact generator for Hydra's own web UI.
//
// The diff viewer runs a per-project "[[artifacts]]" command
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
// Run with: node scripts/screenshots/take-screenshots.ts  (from web/)
//
// Progress: each major step emits a one-line "::hydra:progress::" marker (build
// phases and, during capture, "<name>.png <n>/<total>"). Hydra strips the prefix
// and surfaces the rest as the live progress header - and, once it sees a marker,
// stops treating ordinary stdout as progress, so the noisy subprocess output
// (the install, vite build) below can't hijack the header. Keep markers short and
// human-readable; everything still lands in the full build log.
//
// Streaming: right after writing each "<name>.png" (and its .meta sidecar) we emit
// a "::hydra:artifact:: <name>.png" marker, so Hydra scans + diffs that one tile
// and streams it into the panel as it renders, rather than surfacing every image
// at once when this command exits.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { proxyLaunchOptions } from '../lib/browserProxy.ts'
import { pages, VIDEO_SEEK } from './pages.ts'

// Share the app's localStorage key registry rather than re-typing the 'hydra-*'
// strings: keys are built here in Node and passed into the browser-context init
// scripts below. storage.ts is dependency-free, so it imports cleanly under Node's
// type stripping. The '.ts' extension is required - Node ESM does not guess it.
import { StorageKeys, artifactTagFilterKey, promptDraftKey } from '../../src/lib/storage.ts'

// Identifiers seeded by the simulation server (internal/http/simulation.go),
// named where they feed the shared key builders above.
const SIM_PROJECT = 'sim-project'
const SIM_AGENT = 'agent-1'

// A fixed instant the browser clock is pinned to for every capture, so any
// duration the UI derives from "now" - an agent's "spawned X ago", the artifacts
// panel's elapsed timer - renders deterministically and doesn't make two
// otherwise-identical renders diff (see the nondeterminism note below). It MUST
// match the simulation server's fixed clock (internal/http/simulation.go simNow),
// which dates its mock timestamps relative to this same instant, so e.g. an
// artifact "started 8s ago" reliably reads "8s" rather than 8s/9s by sub-second
// luck.
const SIM_NOW = new Date('2025-01-01T12:00:00Z')

// A markdown-rich spawn-prompt draft seeded into the spawn box for the
// inline-markdown demo. Long enough to wrap in the box (so the wrapped inline-
// code chip is captured), and includes a literal "$ ..." run that must stay
// ordinary code in a prompt (the $-command override is activity-only).

// A short instruction typed into the spawn box, paired with PASTED_LOG_DEMO
// below: the demo shows the user describing a task and then pasting a big log,
// which lands as an attachment chip rather than swamping the instruction.

// A long plain-text block (a CI log) pasted into the spawn box to demo the
// "large paste becomes an attachment" behavior. Well over the 8-line threshold,
// so the first paste is captured as a pasted-text-1.txt chip instead of being
// dumped into the textarea.

// A multi-line HTML snippet "copied from an editor" (the clipboard carries a
// `html` language via vscode-editor-data). Pasting it once attaches it; pasting
// it a second time inlines it for real, wrapped in a ```html fence - the
// code-paste path. Over the 8-line threshold so the first paste attaches.

const OUT = required('HYDRA_ARTIFACT_OUTPUT')
// HYDRA_ARTIFACT_SOURCE is the checkout root. Fall back to the repo root three
// levels up from this script (web/scripts/screenshots/) so it also works by hand.
const SRC = process.env.HYDRA_ARTIFACT_SOURCE || join(import.meta.dirname, '..', '..', '..')
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
// (repository browser, artifacts panel, ...). Grouping by name prefix keeps the
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

// REQUIRED_FONTS are the families a shot's metrics depend on. Every one is a
// Google Fonts face (web/index.html), so it arrives over the network - and if it
// does not, the page silently renders in a fallback with DIFFERENT metrics.
// "Fira Code" is the one that shows: it is --font-mono's first choice, so the
// xterm panels (terminal, artifact/test build logs) measure a different cell and
// every row shifts. Measured: 6.769px per cell with Fira Code, 6.601px without,
// which is what made those shots flap between runs.
const REQUIRED_FONTS = ['Fira Code', 'Inter']

// settle waits for the page to be visually stable before a capture, without a
// fixed sleep: web fonts finished loading, plus two animation frames so any
// pending layout/paint (and React commit) has flushed. With CSS animations and
// transitions disabled (see the injected stylesheet), this is deterministic and
// far quicker than a blanket waitForTimeout. Note the page freezes short
// setTimeouts but leaves requestAnimationFrame intact, so the rAF wait works.
//
// document.fonts.ready alone is NOT enough, for two reasons. It only settles the
// faces the page has already ASKED for, and a font used by a panel that mounts
// later (an xterm) may not be among them; and it resolves just the same when a
// request FAILED, so a fallback render looks identical to a successful one from
// here. So each required family is explicitly requested first, and the result is
// checked rather than assumed.
async function settle(page: import('playwright').Page) {
  const missing = await page.evaluate(async (families: string[]) => {
    if (!document.fonts) return []
    // Ask for each family by name so a face nothing has used yet is fetched now,
    // rather than being absent from the set fonts.ready settles.
    await Promise.all(families.map((f) => document.fonts.load(`16px "${f}"`).catch(() => [])))
    await document.fonts.ready
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    return families.filter((f) => !document.fonts.check(`16px "${f}"`))
  }, REQUIRED_FONTS)

  // Fail loudly rather than capture a shot whose text metrics are wrong. A silent
  // fallback is worse than no shot: it produces a diff that looks like a real UI
  // change and sends you looking for one. Chromium needs the egress proxy handed
  // to it explicitly for these to resolve at all - see docs/screenshots.md.
  if (missing.length > 0) {
    throw new Error(
      `web fonts did not load: ${missing.join(', ')}. Every shot's text metrics would be wrong ` +
        `(the xterm panels measure a different cell width and every row shifts). ` +
        `Chromium needs proxyLaunchOptions() for fonts.googleapis.com to resolve - see docs/screenshots.md.`,
    )
  }
}

// waitForStableRect blocks until an element's bounding box stops moving. The
// lightbox comparator sizes itself from an ASYNC aspect-ratio measurement (a
// `new Image()` onload in LightboxDiff) plus the displayed image's own decode,
// so its layout can shift a frame or two AFTER settle() returns - capturing mid
// shift is what made artifact-lightbox-{ab,onion}-*.png flaky (the image landed
// larger and clipped instead of fit-and-centred). It polls Node-side because the
// in-page clock is pinned (Date.now frozen), so a real-time deadline has to live
// out here; each sample does an in-page rAF first so any pending layout flushes
// between reads. Best-effort: on timeout it returns and the capture proceeds.
async function waitForStableRect(
  page: import('playwright').Page,
  selector: string,
  { stableReads = 3, timeoutMs = 3000, epsilon = 0.5 }: { stableReads?: number; timeoutMs?: number; epsilon?: number } = {},
) {
  const read = () =>
    page.evaluate(async (sel) => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }, selector)

  const near = (a: { x: number; y: number; w: number; h: number } | null, b: typeof a) =>
    a != null && b != null &&
    Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.w - b.w) <= epsilon && Math.abs(a.h - b.h) <= epsilon

  const deadline = Date.now() + timeoutMs
  let prev = await read()
  let stable = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 32)) // Node-side (real) spacing between samples.
    const cur = await read()
    stable = near(cur, prev) ? stable + 1 : 0
    prev = cur
    if (stable >= stableReads) return
  }
}

// captureWithRetry takes a screenshot, retrying a handful of times on the
// transient Chromium protocol errors that surface under load. With up to ~32
// headless contexts capturing in parallel (see the worker pool), a fullPage
// grab can intermittently fail with "Unable to capture screenshot" when several
// large captures coincide and momentarily exhaust the renderer - even though the
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

// Fixed seek time (seconds) for the simulated loader clips - shared by the
// dedicated videoDiff shots and the showArtifacts grid so every webm tile across
// every shot decodes the identical, reproducible frame. Must be an absolute
// timestamp, not duration-relative (see ensureVideosPainted).

// ensureVideosPainted forces every <video> on the page to decode and present a
// stable, deterministic frame so its diff tile actually paints pixels instead of
// showing through to the transparent checkerboard backdrop (checkerStyle). This
// is the flaky "loader-animation.webm renders transparent" symptom: play() is
// no-op'd by the init script, so nothing advances the video on its own, and a
// bare 'seeked' event can fire BEFORE the frame is really decodable - so the
// capture races the first-frame decode and intermittently grabs an empty tile.
//
// Robustness comes from verifying an actual decoded frame exists (a 16×16 canvas
// read-back: drawImage of an undecoded video yields all-transparent pixels) and
// retrying the seek until it does. Timing is driven by requestVideoFrameCallback
// (fires exactly when a frame is composited) with a requestAnimationFrame fallback
// - both deliberately, because the init script collapses every setTimeout under
// 4000ms to 0, so a short setTimeout-based wait would resolve before any decode.
//
// `seek` pins an explicit absolute time. ALWAYS pass one for the simulated
// loader clips: they're MediaRecorder-produced webm with no duration in the
// header, so v.duration is *estimated from buffering* and drifts run-to-run -
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
    // True once the video holds a decoded, non-transparent current frame - i.e.
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
      // VP9 decode off a partial buffer is nondeterministic - the seeked frame
      // lands a frame off (light theme's moving progress bar) or simply decodes
      // with slight pixel noise (dark theme), so the tile flapped run to run while
      // the fully-buffered dedicated shots stayed stable. Kick one load() (NOT one
      // per tick - repeated load() restarts buffering and never converges) then
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
      // (idle but > 0.5s off target - a frame-boundary snap is far smaller).
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
//    must happen before the go build. We invoke vite + the font and
//    routes-regex generators directly rather than `npm run build` to skip the
//    tsc typecheck (a type error in some checkout shouldn't block a screenshot)
//    and the openapi/router codegen (their outputs are committed).
//
//    Install with aube when it is on PATH (much faster), else npm. Both read the
//    committed package-lock.json, so node_modules comes out the same either way.
//    Mirrors webPM() in magefiles/magefile.go.
const webDir = join(SRC, 'web')
const pm = spawnSync('aube', ['--version'], { stdio: 'ignore' }).status === 0 ? 'aube' : 'npm'
progress('building frontend')
run(pm, ['install'], webDir)
// aubx / npx here resolve the locally-installed vite bin (install just ran);
// neither needs to fetch from the registry.
// The Iosevka webfonts are gitignored and cut at build time, so a checkout that
// has never been built has none - and the code/terminal defaults would silently
// fall back to the system monospace in every shot. No-ops once the cache stamp
// matches (see scripts/build-fonts.ts).
run('node', ['scripts/build-fonts.ts'], webDir)
run(pm === 'aube' ? 'aubx' : 'npx', ['vite', 'build'], webDir)
run('node', ['scripts/generate-routes-regex.ts'], webDir)

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
  //    single row) - see internal/http/simulation.go GetAgentDiff(agent-3).
  //
  //    The diff viewer surfaces files that differ between the two versions. It
  //    starts from a byte hash but refines that with a pixel-level decode (see
  //    internal/artifacts Manager.Compare), so renders need only be PIXEL-stable,
  //    not byte-identical - cosmetic encoder/metadata jitter is ignored. We still
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
  const browser = await chromium.launch({ headless: true, args: flags, ...proxyLaunchOptions() })
  try {
    // `scrollTo` names a section <h2> to pin to the top of its scroll container
    // before a non-fullPage capture - used when the interesting content sits
    // below the fold. agent-3's diff tree is below the terminal, so we scroll
    // the "Changes" section to the top and capture just the viewport there
    // instead of the whole (mostly-terminal) page.
    // Capture every page in both themes. Dark mode has its own colours (e.g.
    // diff add/remove backgrounds), so a light-only render would miss visual
    // changes that only show up in dark mode. The app stores its theme
    // preference in localStorage (StorageKeys.themeMode) and toggles a `dark`
    // class on <html>; we seed that key before the app boots so each capture
    // renders the chosen theme deterministically (no reliance on the OS
    // `prefers-color-scheme`). Each render is tagged by theme in its filename:
    // light renders get a `-light` suffix, dark renders a `-dark` suffix.
    const themes = ['light', 'dark'] as const
    // Each (page, theme) capture is fully independent - its own browser context
    // (isolated localStorage/cookies) hitting the shared read-only simulation
    // server - so we run several at once rather than serially. Wall-clock is
    // dominated by per-shot navigation + networkidle + settle waits, so a larger
    // pool cuts it roughly N-fold. The default scales with the host's CPU count
    // but stays a modest fraction of it (roughly a quarter of the cores, clamped
    // to a small range) so capturing the set doesn't saturate the machine - each
    // headless context is a full Chromium render and a context-per-core pool
    // pegs every CPU. Override with HYDRA_SHOT_CONCURRENCY to trade CPU for speed.
    // The clamp bounds peak memory and avoids starving renders of CPU; the
    // captured pixels are per-context deterministic regardless of how many run in
    // parallel, so this doesn't affect the diff-hash reproducibility.
    // HYDRA_SHOT_ONLY (comma-separated page names) narrows the run to a few shots
    // while iterating locally - the full set is slow to capture. Unset ⇒ all pages.
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
        // a tile by its LOGICAL width (physical px ÷ dpi) - a 2x phone shot lays out the
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
        // setFixedTime only freezes the wall clock - timers and requestAnimationFrame
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
          // only appears while *adding* a project - never on open - so the
          // simulated projects (already registered) never trigger it during the
          // capture flow. No pre-trust seeding is needed.
          // Enable the toast harness (window.__hydraToast) so the `toast` page
          // option can drive the toast store. Dormant in the app unless set.
          try { window.localStorage.setItem(opts.harnessKey, '1') } catch { /* ignore */ }
          // Deterministic shuffle (spawn-form placeholder order).
          ;(Math as unknown as { random: () => number }).random = () => 0.5
          // Freeze short-lived timers (the typewriter placeholder animation runs
          // on 30-2500ms timeouts) while leaving long timers/polling intact.
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
        // never resolve - wait only for the DOM for those pages.
        await page.goto(base + pg.path, { waitUntil: pg.holdRequest ? 'domcontentloaded' : 'networkidle' })
        await page.addStyleTag({
          content:
            '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        })
        if (pg.holdRequest) {
          // Wait for the main pane's loading spinner (the h-5 LoaderCircle, unique
          // to the loading state - the tree spinner is h-4, the header one h-3.5).
          // It only appears once branches + tree have loaded and the held file
          // request is in flight, so this confirms the full loading layout.
          await page.waitForSelector('svg.lucide-loader-circle.h-5')
        }
        // Let async data + layout settle before capturing (fonts + frames, no sleep).
        await settle(page)
        // The simulated agent terminal streams a fixed boot transcript over its
        // WebSocket (SimulationServer.HandleTerminalWS), ending in a shell prompt.
        // The WS isn't tracked by networkidle, and xterm renders on its own frame,
        // so wait until that final prompt has painted - otherwise a capture could
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
          // We set height directly - the textarea wrapper is flex-1 min-h-0, so it
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
          // unused for the chip label - the form names it pasted-text-N.txt).
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
            // it's code) - wait until the fence has landed in the box.
            await page.waitForFunction(() =>
              ((document.querySelector('.max-w-4xl textarea') as HTMLTextAreaElement | null)?.value ?? '').includes('```'),
            )
          } else {
            // The first paste attaches it - wait until the chip has rendered and
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
          // (no disk writes, no timing jitter) - the chips then leave their
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
          // elsewhere on the page - e.g. a running test-verdict chip in the
          // sidebar - can't keep it from settling. (The chips render outside the
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
          // which only render after the image's onLoad fires - so the capture
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
          // artifacts panel - the repository branch-compare diff also reads
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
          // The "components" set streams its tiles in over time (the sim's
          // ::hydra:artifact:: demo, see HandleArtifactsWS). Wait for the LAST tile
          // ("toast.png") so the shot always captures the full streamed grid rather
          // than a racy mid-trickle subset.
          if (pg.expandArtifact === 'components') {
            await page.waitForFunction(() => document.body.textContent?.includes('toast.png'), undefined, { timeout: 15000 })
          }
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
          // it - e.g. the "Merge queued" pill's explanation. The tooltip must show
          // synchronously on hover (delay 0): a post-hover wait would let the layout
          // settle and drift the element out from under Playwright's fixed cursor,
          // firing mouseleave and dismissing the (grace-less) dark hint.
          await page.locator(pg.hover).first().hover()
          await settle(page)
        }
        if (pg.pressKey) {
          // Blur the autofocused field (e.g. the spawn textarea) so the chord hits
          // the window-level shortcut handler instead of being typed into it, then
          // press it - used to open the keyboard-shortcuts overlay via `?`.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          await page.keyboard.press(pg.pressKey)
          await settle(page)
        }
        if (pg.openSwitcher) {
          // Hold Ctrl and tap Backquote to open the alt-tab project switcher, then
          // leave Ctrl held so the overlay stays up for the shot (releasing it
          // commits + closes). Blur first so the keydown reaches the window handler.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          await page.keyboard.down('Control')
          await page.keyboard.press('Backquote')
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
          // single entry carries exactly one EnabledToggle - its sr-only "peer"
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
          // networkidle) and sits above the diff, so wait for it first - otherwise
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
          // lays out - and lazy images below the fold would otherwise never load
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
          // shows through to its transparent checkerboard backdrop, or - the bug
          // that named this branch - lands a frame off run to run). Same fixed
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
          // which only render after the lightbox image's onLoad fires - so the
          // capture always includes them (same guard as the spawn-box lightbox).
          await page.waitForFunction(() =>
            !!document.querySelector('figure figcaption')?.textContent?.includes('×'),
          )
          await settle(page)
          // The comparator's fit sizing settles a frame or two after the caption
          // appears (async aspect measurement + image decode), so wait for its
          // image rect to stop moving before capturing - otherwise the shot can
          // catch the pre-fit (larger, clipped) layout. See waitForStableRect.
          await waitForStableRect(page, 'figure img')
          if (pg.lightboxMode) {
            // Switch the in-lightbox comparator to another mode via its selector
            // (button text === the mode label), then let the new layers decode
            // and the comparator re-fit before capturing.
            await page.click(`figure button:text-is("${pg.lightboxMode}")`)
            await settle(page)
            await waitForStableRect(page, 'figure img')
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
          // control now - driving all tiles via context - not a per-tile checkbox, so
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
          // drawn before the capture - otherwise a half-painted (or still-blank)
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
          // Place the "Artifacts" heading at mid-viewport so the tooltip - which
          // opens upward from the (i) icon into a fixed portal - has room above it,
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
          // (the category name, e.g. "theme"). Done after scrollTo so the header -
          // and the dropdown that opens just below it - sits in the viewport.
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
          // ResizeObserver-driven layout settle - so the width-driven grid is
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
          // scrollIntoView behaves - unlike the sticky section headings scrollTo
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
        // section are scoped "category::value" labels - the viewer keeps one
        // value per category and offers each as a single-select filter - so a
        // reviewer can, e.g., show only the dark-mode repository shots. The
        // viewport axis is the page's explicit viewportTag when set (needed for
        // landscape/tablet sizes, which width alone can't classify), otherwise
        // derived from the capture width: narrow → mobile, everything wider →
        // desktop.
        const viewport = pg.viewportTag ?? ((pg.viewport?.width ?? 1280) < 700 ? 'mobile' : 'desktop')
        const tags = [`theme::${theme}`, `viewport::${viewport}`, `section::${sectionFor(pg.name)}`]
        // Record dpi only when non-default (the 2x phone shots) - Hydra treats an
        // absent dpi as 1, so desktop sidecars stay byte-identical to before.
        writeFileSync(`${out}.meta`, JSON.stringify(dpi !== 1 ? { tags, dpi } : { tags }))
        console.log(`wrote ${out}`)
        // Announce the finished file so Hydra scans + diffs just this tile and
        // streams it into the panel now, instead of waiting for the whole run to
        // exit. The path is relative to HYDRA_ARTIFACT_OUTPUT, and both the image
        // and its .meta sidecar are already written above.
        console.log(`::hydra:artifact:: ${pg.name}${suffix}.png`)
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
    // as a failed generation - so ONE flaky page would blank the entire artifacts
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

    // Summarise any per-page failures. We exit 0 as long as at least one shot
    // rendered, so the artifacts panel still shows everything that worked (a
    // failed run is cached as an error and would otherwise show nothing); only a
    // total wipe-out (every shot failed) is treated as a hard failure.
    if (failures.length > 0) {
      console.error(`\n${failures.length} screenshot(s) failed:`)
      for (const f of failures) console.error(`  ✗ ${f}`)
      if (done === 0) throw new Error('every screenshot failed to render')
      console.error(`(continuing - ${done} shot(s) rendered; the artifacts panel shows those)`)
    }
  } finally {
    await browser.close()
  }
} finally {
  server.kill('SIGTERM')
  // Remove the throwaway binary dir (hydra-shot-*). Without this every artifact
  // run leaks a ~30MB dir into the host's /tmp - they pile up fast since this
  // runs on both sides of every screenshot comparison. Safe to unlink even
  // though the server still holds the binary open (Linux/macOS unlink-on-use).
  rmSync(binDir, { recursive: true, force: true })
}

progress('done')
