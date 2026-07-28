// Main-thread client for the syntax-highlight Web Worker pool. Spreads files
// across a small pool of workers (so a big diff colourises in parallel without
// ever touching the UI thread) and degrades gracefully to synchronous,
// main-thread highlighting when Workers are unavailable (tests/SSR) or a worker
// crashes.
import { highlightLines } from './highlightCore'
import type { HighlightRequest, HighlightResponse } from './highlight.worker'

export interface HighlightSides {
  old: string[] | null
  new: string[] | null
}

interface Pending extends HighlightRequest {
  resolve: (r: HighlightSides) => void
}

let workers: Worker[] | null | undefined
let nextWorker = 0
let nextId = 1
const pending = new Map<number, Pending>()

// syncFallback resolves a request on the main thread - used when no worker pool
// exists and to drain in-flight requests if a worker errors out.
function syncFallback(req: { lang: string; old: string[] | null; new: string[] | null }): HighlightSides {
  const runs = (side: string[] | null) =>
    side != null ? side.flatMap((run) => highlightLines(run, req.lang)) : null
  return { old: runs(req.old), new: runs(req.new) }
}

function teardownAndFallback() {
  // A worker died: resolve everything still in flight synchronously and stop
  // using the pool so later requests don't hang waiting on dead workers.
  for (const w of workers ?? []) w.terminate()
  workers = null
  for (const p of pending.values()) p.resolve(syncFallback(p))
  pending.clear()
}

function ensureWorkers(): Worker[] | null {
  if (workers !== undefined) return workers ?? null
  if (typeof Worker === 'undefined') { workers = null; return null }
  try {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
    const count = Math.max(1, Math.min(3, cores - 1))
    workers = Array.from({ length: count }, () => {
      const w = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<HighlightResponse>) => {
        const p = pending.get(e.data.id)
        if (!p) return
        pending.delete(e.data.id)
        p.resolve({ old: e.data.old, new: e.data.new })
      }
      w.onerror = teardownAndFallback
      return w
    })
  } catch {
    workers = null
  }
  return workers
}

// highlightSides highlights the old and new sides of a file off the main thread,
// returning per-line HTML for each side (null when that side is empty). Each
// side is passed as one string per contiguous run of lines - never glued into a
// single string, which would let a construct truncated at a collapsed gap run on
// into the fragments below it (see DiffViewer's contiguousRuns).
export function highlightSides(lang: string, oldCode: string[] | null, newCode: string[] | null): Promise<HighlightSides> {
  const ws = ensureWorkers()
  if (!ws) return Promise.resolve(syncFallback({ lang, old: oldCode, new: newCode }))
  const id = nextId++
  const w = ws[nextWorker++ % ws.length]
  return new Promise<HighlightSides>((resolve) => {
    pending.set(id, { id, lang, old: oldCode, new: newCode, resolve })
    w.postMessage({ id, lang, old: oldCode, new: newCode } satisfies HighlightRequest)
  })
}
