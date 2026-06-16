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
// Run with: bun take-screenshots.ts  (from scripts/screenshots/)
//
// Progress: each major step prints a one-line marker on stdout (build phases and,
// during capture, "<name>.png <n>/<total>"). Hydra surfaces the latest stdout
// line as live progress in the artifacts panel while this runs, so keep these
// lines short and human-readable.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

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
console.log('building frontend')
run('bun', ['install'], webDir)
run('bun', ['x', 'vite', 'build'], webDir)
run('bun', ['scripts/generate-routes-regex.ts'], webDir)

// 2. Build the hydra binary from the checkout into a throwaway dir.
console.log('building hydra binary')
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
  console.log('booting simulation server')
  await waitForServer(base + '/', 30_000)
  console.log('capturing screenshots')

  // 4. Screenshot the pages. The home page ("/") shows the full app shell:
  //    header, project dropdown, agent sidebar (populated with mock data) and
  //    the main content pane. The "nested-folders" page opens a simulated
  //    agent (agent-3) whose diff spans deeply nested paths, so the captured
  //    diff tree shows VS Code-style compacted folders (one/two/three on a
  //    single row) — see internal/http/simulation.go GetAgentDiff(agent-3).
  //
  //    The diff viewer compares versions by hashing the output bytes and only
  //    surfaces files that differ, so the render MUST be byte-reproducible —
  //    otherwise unchanged UI would always look "modified". Two sources of
  //    nondeterminism are neutralized:
  //      * Chromium font anti-aliasing: pinned with the flags below
  //        (no GPU, no LCD/subpixel text, fixed hinting + color profile).
  //      * App-level animation: an init script freezes Math.random (the spawn
  //        form shuffles its placeholder phrases) and no-ops the short timers
  //        that drive the typewriter placeholder, and a stylesheet disables CSS
  //        animations/transitions and the text caret.
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
      // Seeds the diff viewer's image-diff comparison mode ('hydra-diff-image-mode')
      // before the app boots, so the artifacts panel renders before/after pairs in
      // the chosen mode. Only meaningful on the artifacts (agent-1) page.
      imageDiffMode?: 'side-by-side' | 'ab' | 'slider' | 'onion'
      // Expands the named artifact card (clicks its header) after load — used to
      // document the in-flight card's live, scrollable generation log.
      expandArtifact?: string
    }[] = [
      { name: 'home', path: '/' },
      // The repository view: a GitHub-style browser with a file/folder tree on
      // the left and the picked file rendered on the right. Simulation mode
      // serves a small mock repo (see internal/http/simulation.go) and opens
      // README.md by default, so the capture shows rendered markdown beside the
      // tree. Full-page; the layout fills the viewport with internal scroll.
      { name: 'repository', path: '/project/sim-project/repository' },
      // The repository view showing a source file: a deep-linked URL
      // (/repository/<ref>/<path>) renders the file with line numbers and the
      // tree auto-expanded down to it (folders are otherwise collapsed). Demos
      // PLAN.md #41a (line numbers) + #41d (wrapping) + #41f (URL routing).
      { name: 'repository-code', path: '/project/sim-project/repository/main/internal/server/server.go' },
      // The branch selector opened over the source-file view: Hydra agent
      // branches (hydra/*) are listed first (PLAN.md #41b).
      {
        name: 'repository-branches',
        path: '/project/sim-project/repository/main/internal/server/server.go',
        click: 'button[title="Switch branch"]',
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
      { name: 'nested-folders', path: '/project/sim-project/agent/agent-3', scrollTo: 'Changes' },
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
      // The in-flight artifact card expanded to reveal its live generation log:
      // a scrollable, monospaced stdout+stderr stream (stderr in red), with the
      // header showing the latest line and elapsed time. agent-1's "components"
      // set is the generating one (see internal/http/simulation.go simArtifactLog).
      {
        name: 'artifact-log',
        path: '/project/sim-project/agent/agent-1',
        scrollTo: 'Changes',
        viewport: { width: 1280, height: 1280 },
        imageDiffMode: 'side-by-side',
        expandArtifact: 'components',
      },
    ]
    // Capture every page in both themes. Dark mode has its own colours (e.g.
    // diff add/remove backgrounds), so a light-only render would miss visual
    // changes that only show up in dark mode. The app stores its theme
    // preference in localStorage ('hydra-theme-mode') and toggles a `dark`
    // class on <html>; we seed that key before the app boots so each capture
    // renders the chosen theme deterministically (no reliance on the OS
    // `prefers-color-scheme`). Light renders keep their original filenames; dark
    // renders get a `-dark` suffix.
    const themes = ['light', 'dark'] as const
    let shot = 0
    const totalShots = pages.length * themes.length
    for (const pg of pages) {
      for (const theme of themes) {
        const suffix = theme === 'dark' ? '-dark' : ''
        shot++
        // Progress line surfaced live by Hydra (it shows the latest stdout line
        // while generating): e.g. "artifacts-ab-dark.png 7/12". Logged at the
        // start of the (slow) capture so it persists while the shot is taken.
        console.log(`${pg.name}${suffix}.png ${shot}/${totalShots}`)
        const ctx = await browser.newContext({
          viewport: pg.viewport ?? { width: 1280, height: 800 },
          deviceScaleFactor: 1,
          colorScheme: theme,
        })
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
        await ctx.addInitScript(() => {
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
        })
        const page = await ctx.newPage()
        await page.goto(base + pg.path, { waitUntil: 'networkidle' })
        await page.addStyleTag({
          content:
            '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        })
        // Let async data + layout settle before capturing (fonts + frames, no sleep).
        await settle(page)
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
        const out = join(OUT, `${pg.name}${suffix}.png`)
        // Scrolled pages capture the viewport (so the scroll is meaningful);
        // others capture the full page.
        await page.screenshot({ path: out, fullPage: !pg.scrollTo })
        console.log(`wrote ${out}`)
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
  }
} finally {
  server.kill('SIGTERM')
}

console.log('done')
