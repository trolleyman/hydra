/// <reference types="node" />
// Focused screenshotter for the artifacts video diff viewer (web/src/components/
// VideoDiffView.tsx). Boots `hydra server --simulation` (which now serves a demo
// .webm artifact — see internal/http/simulation_video.go) and captures the
// loader-animation.webm file row in each diff mode, paused on a mid frame so the
// before/after progress bar differs. Unlike take-screenshots.ts this is a manual
// dev helper, not the byte-stable artifact generator, so it keeps real timers
// (video playback needs them) and shoots one element rather than the whole panel.
//
// Run from web/:  HYDRA_BIN=/path/to/hydra bun scripts/screenshots/shoot-video.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const SRC = join(import.meta.dir, '..', '..', '..')
const BIN = process.env.HYDRA_BIN || '/tmp/hydra-vidshot'
const OUT = join(import.meta.dir, 'out-video')
const MODES = ['side-by-side', 'ab', 'slider', 'onion', 'difference'] as const
const VIDEO_NAME = 'loader-animation.webm'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const port = (srv.address() as import('node:net').AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server not ready at ${url}`)
}

mkdirSync(OUT, { recursive: true })
const port = await freePort()
const addr = `127.0.0.1:${port}`
const base = `http://${addr}`
const server: ChildProcess = spawn(BIN, ['server', '--simulation'], {
  cwd: SRC,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, HYDRA_API_ADDR: addr },
})

try {
  await waitForServer(base + '/', 30_000)
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required'] })

  for (const theme of ['dark', 'light'] as const) {
    for (const mode of MODES) {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme })
      await ctx.addInitScript((m) => {
        try {
          localStorage.setItem('hydra-theme-mode', m.theme)
          localStorage.setItem('hydra-diff-image-mode', m.mode)
          localStorage.setItem('hydra-trusted-projects', '["sim-project"]')
        } catch { /* ignore */ }
      }, { theme, mode })
      const page = await ctx.newPage()
      await page.goto(base + '/project/sim-project/agent/agent-1', { waitUntil: 'networkidle' })
      // The "screenshots" set card is collapsed by default; wait for its header,
      // expand it, then wait for the video file row to render.
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('screenshots')))
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('screenshots'))
        btn?.click()
      })
      await page.waitForFunction((name) =>
        Array.from(document.querySelectorAll('span')).some((s) => s.textContent?.trim() === name), VIDEO_NAME)
      // Pause every video on a mid frame and wait for the seek, so the before/after
      // progress bars are partly filled (and differ) rather than caught at 0/100%.
      await page.evaluate(async () => {
        const vids = Array.from(document.querySelectorAll('video'))
        await Promise.all(vids.map((v) => new Promise<void>((res) => {
          v.pause()
          const done = () => { v.removeEventListener('seeked', done); res() }
          v.addEventListener('seeked', done)
          try { v.currentTime = (v.duration && isFinite(v.duration) ? v.duration : 2) * 0.6 } catch { res() }
          setTimeout(res, 800)
        })))
      })
      // Give the difference-mode canvas (throttled ~20fps) a couple of redraws.
      await page.waitForTimeout(400)
      const row = await page.evaluateHandle((name) => {
        const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent?.trim() === name)
        return span?.closest('div.rounded-lg') ?? null
      }, VIDEO_NAME)
      const el = row.asElement()
      if (!el) throw new Error('video file row not found')
      await el.scrollIntoViewIfNeeded()
      const path = join(OUT, `video-${mode}-${theme}.png`)
      await el.screenshot({ path })
      console.log('wrote', path)
      await ctx.close()
    }
  }
  await browser.close()
} finally {
  server.kill()
}
