import { chromium } from 'playwright'
import { readFileSync } from 'fs'

const port = readFileSync('/tmp/simport', 'utf8').trim()
const base = `http://localhost:${port}`

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors: string[] = []
const pageErrors: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => pageErrors.push(String(e)))

// agent-md is the chat-view (markdown) simulated agent.
await page.goto(`${base}/project/sim-project/agent/agent-md`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)

const bodyText = await page.evaluate(() => document.body.innerText)

const hasContinueFrom = bodyText.includes('Continue from where you left off')
const hasNoResponse = bodyText.includes('No response requested')
// Positive controls: real chat content that MUST still render.
const hasRealText = bodyText.includes('retry loop') || bodyText.includes('backoff')
const hasInterrupt = bodyText.includes('Request interrupted by user') || bodyText.includes('interrupted')

console.log(JSON.stringify({
  phantom_continue_from_present: hasContinueFrom,
  phantom_no_response_present: hasNoResponse,
  real_chat_text_present: hasRealText,
  interrupt_chip_present: hasInterrupt,
  consoleErrors: consoleErrors.filter((e) => !/uploads\/projects|folder-picker|api\/auth\/status/.test(e)),
  pageErrors,
}, null, 2))

await browser.close()
