import { chromium } from 'playwright'
import { proxyLaunchOptions } from './lib/browserProxy.ts'
import { readFileSync } from 'node:fs'

const port = readFileSync('/tmp/hostrun-sim-port.txt', 'utf8').match(/PORT=(\d+)/)![1]
const base = `http://localhost:${port}`

const browser = await chromium.launch(proxyLaunchOptions())
const page = await browser.newPage()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.addInitScript(() => {
  try { localStorage.setItem('hydra-toast-harness', '1') } catch { /* ignore */ }
})
await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })

await page.evaluate(() => {
  const h = (window as unknown as { __hydraToast?: { reset: () => void; show: (s: unknown) => void } }).__hydraToast
  if (!h) throw new Error('toast harness not installed')
  h.reset()
  h.show({
    message: '',
    type: 'warning',
    actions: [
      { label: 'Allow once', variant: 'primary' },
      { label: 'Deny', variant: 'danger' },
    ],
    approval: {
      kind: 'host_command',
      target: 'cd "$HOME/tools" && ./gen-certs.sh --local ; security add-trusted-cert -d dev-root.pem',
      agentName: 'Set up local HTTPS certs',
      agentId: 'agent-approval',
      projectId: 'sim-project',
    },
  })
})

await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 })

const box = await page.evaluate(() => {
  const el = document.querySelector('[role="alertdialog"]')
  if (!el) return null
  const pre = el.querySelector('pre')
  return {
    // Did chain-splitting insert newlines? (three logical steps -> multi-line)
    lineCount: (pre?.textContent ?? '').split('\n').length,
    // Did highlight.js run? (it emits hljs-* token spans)
    highlightSpans: pre?.querySelectorAll('span[class^="hljs-"]').length ?? 0,
    // The FULL command text preserved verbatim (minus the inserted newlines)?
    textReassembled: (pre?.textContent ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(),
    buttons: Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim()).filter(Boolean),
  }
})

await page.screenshot({ path: '/tmp/hostrun-card-hl.png' })
console.log(JSON.stringify({ box, errors }, null, 2))
await browser.close()
