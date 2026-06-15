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
// Run with: bun take-screenshot.ts  (from scripts/screenshots/)

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

console.log(`Rendering Hydra UI for ref ${REF} from ${SRC}`)

// 1. Build the frontend. The Go binary embeds web/dist (web/embed.go), so this
//    must happen before the go build. We invoke vite + the routes-regex
//    generator directly rather than `bun run build` to skip the tsc typecheck
//    (a type error in some checkout shouldn't block a screenshot) and the
//    openapi/router codegen (their outputs are committed).
const webDir = join(SRC, 'web')
run('bun', ['install'], webDir)
run('bun', ['x', 'vite', 'build'], webDir)
run('bun', ['scripts/generate-routes-regex.ts'], webDir)

// 2. Build the hydra binary from the checkout into a throwaway dir.
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
  await waitForServer(base + '/', 30_000)

  // 4. Screenshot the pages. The home page ("/") shows the full app shell:
  //    header, project dropdown, agent sidebar (populated with mock data) and
  //    the main content pane.
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
    const pages: { name: string; path: string }[] = [{ name: 'home', path: '/' }]
    for (const pg of pages) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      })
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
      // Let async data + layout settle before capturing.
      await page.waitForTimeout(800)
      const out = join(OUT, `${pg.name}.png`)
      await page.screenshot({ path: out, fullPage: true })
      console.log(`wrote ${out}`)
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
} finally {
  server.kill('SIGTERM')
}

console.log('done')
