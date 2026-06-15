// Pure-Node Chrome DevTools Protocol driver for the #34 selection repro.
// No npm installs. The sandbox blocks Chrome from binding a TCP devtools port, so
// we speak CDP over a PIPE (--remote-debugging-pipe: child fd 3 = commands in,
// fd 4 = events/results out; messages are NUL-delimited JSON). Drives the host's
// google-chrome against the Vite-served harness page (repro/diffsel.html).
//
// Usage: node scripts/cdp-diffsel.mjs <harness-url>
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.argv[2] ?? 'http://localhost:5173/repro/diffsel.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Use Playwright's already-cached Chromium-for-Testing, NOT the host's installed
// Google Chrome (the sandbox should not interfere with host-OS apps). Override with
// CHROME_BIN if needed.
const CHROME_BIN = process.env.CHROME_BIN
  || `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`
const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-repro-'))
const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--remote-debugging-pipe', `--user-data-dir=${userDataDir}`,
  '--window-size=1280,1400', URL,
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })

const pipeWrite = chrome.stdio[3] // we write CDP commands → child fd 3
const pipeRead = chrome.stdio[4]  // child fd 4 → we read results/events

function cleanup(code) { try { chrome.kill('SIGKILL') } catch {} process.exit(code) }

let nextId = 1
const pending = new Map()
const sessionEvents = []
let buf = Buffer.alloc(0)
pipeRead.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  let nul
  while ((nul = buf.indexOf(0)) !== -1) {
    const raw = buf.subarray(0, nul).toString('utf8')
    buf = buf.subarray(nul + 1)
    if (!raw) continue
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    else if (msg.method) sessionEvents.push(msg)
  }
})

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
    const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })
    pipeWrite.write(payload + '\0')
  })
}

async function evalJs(session, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session)
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)))
  return r.result.value
}

async function main() {
  // Find the page target for our harness URL.
  let targetId
  for (let i = 0; i < 50 && !targetId; i++) {
    const { targetInfos } = await send('Target.getTargets')
    const page = targetInfos.find((t) => t.type === 'page' && t.url.includes('diffsel'))
    if (page) targetId = page.targetId
    else await sleep(200)
  }
  if (!targetId) throw new Error('no page target found')

  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)

  // Wait for the diff line to render (getAgentDiff resolves async).
  let rendered = false
  for (let i = 0; i < 60; i++) {
    const ok = await evalJs(sessionId, `!!document.body.textContent.includes('hello there friend')`)
    if (ok) { rendered = true; break }
    await sleep(200)
  }
  if (!rendered) throw new Error('diff never rendered')

  const out = {}

  // Experiment A: bare parent re-render (no prop/content change).
  out.selA = await evalJs(sessionId, `window.__selectLine()`)
  await sleep(50)
  await evalJs(sessionId, `window.__rerender()`)
  await sleep(250)
  out.afterRerender = await evalJs(sessionId, `window.__selection()`)

  // Experiment B: the real silent-refresh path (externalRefreshTrigger bump,
  // identical diff + commits returned — the idle-tick scenario behind #34).
  out.selB = await evalJs(sessionId, `window.__selectLine()`)
  await sleep(50)
  await evalJs(sessionId, `window.__tick()`)
  await sleep(600)
  out.afterTick = await evalJs(sessionId, `window.__selection()`)

  // Repeated idle ticks.
  for (let i = 0; i < 3; i++) { await evalJs(sessionId, `window.__tick()`); await sleep(300) }
  out.afterManyTicks = await evalJs(sessionId, `window.__selection()`)
  out.counters = await evalJs(sessionId, `document.querySelector('[data-testid=rerender-count]').textContent`)

  console.log(JSON.stringify(out, null, 2))

  const captured = !!out.selA && out.selA === out.selB && out.selA.length > 3
  const passRerender = out.afterRerender === out.selA && out.afterRerender !== ''
  const passTick = out.afterTick === out.selB && out.afterTick !== ''
  const passMany = out.afterManyTicks === out.selB && out.afterManyTicks !== ''
  console.log('\n--- RESULTS ---')
  console.log('selection captured:                    ', captured ? 'yes' : 'NO')
  console.log('bare re-render preserves selection:    ', passRerender ? 'PASS' : 'FAIL')
  console.log('silent refresh preserves selection:    ', passTick ? 'PASS' : 'FAIL')
  console.log('repeated idle ticks preserve selection:', passMany ? 'PASS' : 'FAIL')
  cleanup(captured && passRerender && passTick && passMany ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e.message); cleanup(2) })
