import { chromium } from 'playwright'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { proxyLaunchOptions } from './lib/browserProxy.ts'

// Capture a small HTML fragment against Hydra's production CSS in both themes.
// This is for showing a focused UI treatment in chat without keeping a one-off
// Playwright driver. Build the web app first, then run from web/:
//
//   node scripts/capture-theme-snippet.ts \
//     --html /tmp/example.html --output /tmp/example --width 760 --height 150
//
// The HTML file is inserted inside <body>. Put data-capture on a child to crop
// tightly to it; otherwise the viewport is captured. Outputs are
// <output>-light@2x.png and <output>-dark@2x.png.

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const htmlPath = value('--html')
const output = value('--output')
const width = Number(value('--width') ?? 760)
const height = Number(value('--height') ?? 240)
if (!htmlPath || !output || !existsSync(htmlPath) || !Number.isFinite(width) || !Number.isFinite(height)) {
  console.error('Usage: node scripts/capture-theme-snippet.ts --html <file> --output <base> [--width 760] [--height 240]')
  process.exit(2)
}

function productionCSS(): string {
  const files = readdirSync('dist/assets')
  const plain = files.find((name) => /^index-.*\.css$/.test(name))
  if (plain) return readFileSync(`dist/assets/${plain}`, 'utf8')
  const compressed = files.find((name) => /^index-.*\.css\.gz$/.test(name))
  if (compressed) return gunzipSync(readFileSync(`dist/assets/${compressed}`)).toString()
  throw new Error('Production CSS not found. Run `aube run build` from web/ first.')
}

const fragment = readFileSync(htmlPath, 'utf8')
const css = productionCSS()
const browser = await chromium.launch({ headless: true, ...proxyLaunchOptions() })

for (const theme of ['light', 'dark'] as const) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme,
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.setContent(`<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}"><body>${fragment}</body></html>`)
  await page.addStyleTag({ content: css })
  await page.evaluate(() => document.fonts.ready)
  const target = page.locator('[data-capture]').first()
  const path = `${output}-${theme}@2x.png`
  if (await target.count()) await target.screenshot({ path })
  else await page.screenshot({ path })
  if (errors.length) throw new Error(`${theme} capture logged errors:\n${errors.join('\n')}`)
  await context.close()
  console.log(path)
}

await browser.close()
