import type { BrowserContext } from 'playwright'

// Serve the Google-hosted webfonts from one in-process cache, so a run that
// makes many browser contexts fetches them once instead of once per context.
//
// take-screenshots creates a FRESH context per (page, theme) - ~80 of them - and
// each has its own isolated HTTP cache, so nothing is shared between shots. Every
// shot then waits for `networkidle`, which means each font request sits directly
// on that shot's critical path. Fetching Merriweather + Roboto Flex ~80 times
// over the sandbox's egress proxy is pure repeated latency for bytes that never
// change within a run.
//
// This also removes the network from the render entirely after the first shot,
// which is worth having on its own: a slow or flaky proxy can no longer stretch
// the wall-clock or, worse, let a font arrive late enough to miss the capture and
// produce a spurious pixel diff.
type Entry = { status: number; contentType: string; body: Buffer }

const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//

const cache = new Map<string, Entry>()
// Concurrent shots ask for the same URL at the same time; without this the first
// N contexts would each fetch it before any of them populated the cache.
const inflight = new Map<string, Promise<Entry | null>>()

/**
 * Route this context's webfont requests through the shared cache. Call it on
 * every context you create; the first one pays for the fetch and the rest are
 * served from memory.
 */
export async function cacheWebfonts(ctx: BrowserContext): Promise<void> {
  await ctx.route(FONT_HOSTS, async (route) => {
    const url = route.request().url()
    const hit = cache.get(url)
    if (hit) {
      await route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body })
      return
    }
    let pending = inflight.get(url)
    if (!pending) {
      pending = (async () => {
        try {
          const res = await route.fetch()
          // Only the decoded body and its type are kept: replaying the original
          // headers would replay content-encoding/length against a body that has
          // already been decoded.
          const entry: Entry = {
            status: res.status(),
            contentType: res.headers()['content-type'] ?? 'application/octet-stream',
            body: await res.body(),
          }
          if (entry.status < 400) cache.set(url, entry)
          return entry
        } catch {
          return null
        } finally {
          inflight.delete(url)
        }
      })()
      inflight.set(url, pending)
    }
    const entry = await pending
    if (!entry) {
      // No network (or the proxy refused). Abort rather than hang: the page
      // falls back to the next font in the stack, exactly as it did before the
      // proxy was wired up, instead of stalling the shot's networkidle wait.
      await route.abort()
      return
    }
    await route.fulfill({ status: entry.status, contentType: entry.contentType, body: entry.body })
  })
}
