/* eslint-disable @typescript-eslint/no-explicit-any -- reads ad-hoc window
   globals (__stats/__resetStats) set inside page.evaluate browser context. */
// rerender-probe - a zero-source-change re-render detector for the app.
//
// It installs a minimal React DevTools hook BEFORE the page's React loads and,
// on every commit, walks the fiber tree counting which components performed work
// (the PerformedWork flag React sets so DevTools can tell a real render from a
// memo/bailout skip). Point it at a route, optionally drive an interaction, and
// it prints commits + per-component render counts - so you can see what a 1s
// store tick or a keystroke actually re-renders, and whether a memo() holds.
//
// Usage (needs a dev build - `npx vite build --mode development` - so component
// names aren't minified, and a running server on $PORT):
//   PORT=26600 node scripts/rerender-probe.ts <path> [--type <selector>] [--secs N]
// Examples:
//   PORT=26600 node scripts/rerender-probe.ts /project/sim-project/agent/agent-1
//   PORT=26600 node scripts/rerender-probe.ts /project/sim-project --type 'textarea' --secs 3
//
// CAVEAT: the PerformedWork flag over-counts for a few wrapper/forwardRef fibers
// (e.g. a lucide icon can show renders even when its memo'd parent bailed). Treat
// the output as directional. To NAIL a hot component, drop a one-line counter in
// its body and read it back - ground truth:
//   if (typeof window !== 'undefined') { const w = window as any; w.__rc = w.__rc || {}; w.__rc.Foo = (w.__rc.Foo||0)+1 }
// then `await page.evaluate(() => (window as any).__rc)`.
import { chromium } from 'playwright'
import { proxyLaunchOptions } from './lib/browserProxy.ts'

const PORT = process.env.PORT ?? '26600'
const BASE = `http://localhost:${PORT}`

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--')) ?? '/'
const typeSel = argVal('--type')
const secs = Number(argVal('--secs') ?? (typeSel ? '2' : '5'))
function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// Installed before any page script runs, so it's present when react-dom calls
// injectInternals and enables the PerformedWork bookkeeping.
const initScript = `
(() => {
  const stats = { commits: 0, byName: {} };
  window.__stats = stats;
  window.__resetStats = () => { stats.commits = 0; stats.byName = {}; };
  const PerformedWork = 1;
  function nameOf(t) {
    if (t == null) return null;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (typeof t === 'object') {
      if (t.displayName) return t.displayName;
      if (t.render) return t.render.displayName || t.render.name || 'ForwardRef';
      if (t.type) return nameOf(t.type);
    }
    return null;
  }
  function walk(f) {
    if (!f) return;
    if ((f.flags & PerformedWork) !== 0) { const n = nameOf(f.type); if (n) stats.byName[n] = (stats.byName[n] || 0) + 1; }
    if (f.child) walk(f.child);
    if (f.sibling) walk(f.sibling);
  }
  const hook = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onCommitFiberRoot(_i, root) { stats.commits++; try { walk(root.current); } catch (e) {} },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    getFiberRoots() { return new Set(); }, setStrictMode() {},
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
})();
`

function top(byName: Record<string, number>, n = 25): string {
  return Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `  ${String(v).padStart(6)}  ${k}`).join('\n')
}

async function main() {
  const browser = await chromium.launch(proxyLaunchOptions())
  const page = await browser.newPage()
  await page.addInitScript({ content: initScript })
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]))

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  // Let async work (syntax highlighting, replay) settle so it doesn't count as churn.
  await page.waitForTimeout(3000)

  if (typeSel) {
    await page.locator(typeSel).first().click()
    await page.evaluate(() => (window as any).__resetStats())
    await page.locator(typeSel).first().type('the quick brown fox jumps', { delay: 30 })
    await page.waitForTimeout(300)
    const s = await page.evaluate(() => (window as any).__stats)
    console.log(`\nTYPING into ${typeSel} on ${path}`)
    console.log('commits:', s.commits)
    console.log('renders by component:\n' + top(s.byName))
  } else {
    await page.evaluate(() => (window as any).__resetStats())
    await page.waitForTimeout(secs * 1000)
    const s = await page.evaluate(() => (window as any).__stats)
    console.log(`\nIDLE ${secs}s on ${path}`)
    console.log('commits:', s.commits)
    console.log('renders by component:\n' + top(s.byName))
  }
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
