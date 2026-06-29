/// <reference types="node" />
// One-off generator (NOT committed): renders two small animated .webm clips with
// the bundled Chromium's MediaRecorder — a "before" and a slightly different
// "after" — and prints them as base64 so they can be embedded in the simulation
// server as a demo video artifact. Run: bun gen-demo-webm.ts
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const W = 280, H = 150, FPS = 12, SECONDS = 2

async function record(variant: 'before' | 'after'): Promise<string> {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent('<canvas id="c" width="' + W + '" height="' + H + '"></canvas>')
  const b64 = await page.evaluate(async ({ W, H, FPS, SECONDS, variant }) => {
    const canvas = document.getElementById('c') as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const stream = canvas.captureStream(FPS)
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 800_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    const done = new Promise<Blob>((res) => { rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' })) })

    const total = FPS * SECONDS
    const after = variant === 'after'
    function frame(i: number) {
      const t = i / total
      // Identical static card both sides — only the progress fill differs, so the
      // difference view highlights just the bar (not the whole frame).
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#1e293b'
      ctx.fillRect(20, 20, W - 40, H - 40)
      ctx.fillStyle = '#e2e8f0'; ctx.font = '600 16px sans-serif'
      ctx.fillText(after ? 'Loading…' : 'Loading…', 36, 54)
      // Track.
      const bx = 36, by = 84, bw = W - 72, bh = 18
      ctx.fillStyle = '#334155'; ctx.fillRect(bx, by, bw, bh)
      // Fill: before is linear blue, after eases ahead in emerald — differs in
      // colour everywhere filled and in leading-edge position.
      const p = after ? 1 - Math.pow(1 - t, 2) : t
      ctx.fillStyle = after ? '#10b981' : '#3b82f6'
      ctx.fillRect(bx, by, bw * p, bh)
      ctx.fillStyle = '#94a3b8'; ctx.font = '12px sans-serif'
      ctx.fillText(Math.round(p * 100) + '%', bx, by + bh + 18)
    }

    rec.start()
    for (let i = 0; i <= total; i++) {
      frame(i)
      await new Promise((r) => setTimeout(r, 1000 / FPS))
    }
    rec.stop()
    const blob = await done
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
    return btoa(s)
  }, { W, H, FPS, SECONDS, variant })
  await browser.close()
  return b64
}

const before = await record('before')
const after = await record('after')
console.log('before bytes:', Math.round((before.length * 3) / 4), 'after bytes:', Math.round((after.length * 3) / 4))
writeFileSync('demo-webm-before.b64', before)
writeFileSync('demo-webm-after.b64', after)
console.log('wrote demo-webm-before.b64 / demo-webm-after.b64')
