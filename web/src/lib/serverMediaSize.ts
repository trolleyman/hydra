// Asking the backend how big a chat picture is, before fetching it.
//
// An image is the one thing in a chat message whose height arrives LATER than
// the message does. The browser has no way to know a picture's size without
// downloading it, so a screenshot at the end of a streaming turn lands as a
// zero-height box that is suddenly several hundred pixels tall - shoving the
// transcript under whoever is reading it. (lib/selfReflow exists to cope with
// the aftermath; this is an attempt to stop causing it.)
//
// The backend has the file on disk and can read its header for nothing, so it
// answers in one small round trip that runs ALONGSIDE the image loads rather
// than behind them - see internal/http/agentfiles.go. The answer lands in the
// shared size cache (lib/mediaSize), so the picture is laid out from it and the
// lightbox already knows the size when you click.
//
// Requests are batched per render rather than sent per picture. React renders a
// whole transcript in one commit, so every image's effect runs in the same task;
// a microtask flush after them collects the lot into one request. Otherwise a
// backfilled transcript would fire one small request per image, and on HTTP/1.1
// they would queue behind the image downloads they are meant to get ahead of.

import { useEffect, useState } from 'react'
import { fetchAgentFileSizes } from '../api/uploads'
import { recallMediaSize, rememberMediaSize } from './mediaSize'

/** Matches the backend's per-request cap (maxAgentFileSizes). */
const MAX_BATCH = 64

// One pending batch per head: the paths still to ask about, and the url each one
// resolved to (which is the key the size is remembered under, since that is what
// every consumer - the <img>, the lightbox - actually has in hand).
interface Batch {
  projectId: string
  agentId: string
  paths: Map<string, string>
}
const pending = new Map<string, Batch>()
// Paths already asked about, so a re-render (or a second copy of the same
// picture) doesn't ask again. Holds the misses too - a path the backend couldn't
// measure won't become measurable by asking a second time, and re-asking on
// every render of a message full of unreadable paths would be a request loop.
const asked = new Set<string>()
// Set while a flush is scheduled, so N images in one commit schedule one.
let scheduled = false

// Everyone waiting for the current batch: called once its sizes are in the
// cache, so each image re-renders and reads its own.
const waiters = new Set<() => void>()

async function flush() {
  scheduled = false
  const batches = [...pending.values()]
  pending.clear()
  const wake = [...waiters]
  waiters.clear()
  await Promise.all(batches.map(async (b) => {
    const entries = [...b.paths.entries()]
    for (let i = 0; i < entries.length; i += MAX_BATCH) {
      const chunk = entries.slice(i, i + MAX_BATCH)
      const sizes = await fetchAgentFileSizes(b.projectId, b.agentId, chunk.map(([p]) => p))
      for (const [path, url] of chunk) {
        const size = sizes[path]
        if (size) rememberMediaSize(url, size.width, size.height)
      }
    }
  }))
  wake.forEach((w) => w())
}

/**
 * The natural pixel size of `path` (an image an agent referenced in a chat
 * message), from the backend, or null until it answers - or forever, if it
 * can't. `url` is what that path resolves to, and the key the size is cached
 * under.
 *
 * Pass a null url (a data: URL, an unresolvable path, a surface with no head) to
 * skip the ask entirely: there is nothing on disk for the backend to measure,
 * and the caller's own decode is the only answer available.
 */
export function useServerMediaSize(
  url: string | null,
  path: string | undefined,
  ctx: { projectId: string; agentId?: string } | undefined,
): { w: number; h: number } | null {
  const [, bump] = useState(0)
  const projectId = ctx?.projectId
  const agentId = ctx?.agentId
  useEffect(() => {
    if (!url || !path || !projectId || !agentId) return
    // Already known - by an earlier ask, by the lightbox, by this image's own
    // decode landing first. Nothing to do.
    if (recallMediaSize(url)) return
    const key = `${projectId}\0${agentId}\0${path}`
    if (asked.has(key)) return
    asked.add(key)
    const batchKey = `${projectId}\0${agentId}`
    const batch = pending.get(batchKey) ?? { projectId, agentId, paths: new Map<string, string>() }
    batch.paths.set(path, url)
    pending.set(batchKey, batch)
    let live = true
    const wake = () => { if (live) bump((n) => n + 1) }
    waiters.add(wake)
    if (!scheduled) {
      scheduled = true
      // A microtask, not a timer: React flushes a commit's effects in one task,
      // so this runs after ALL of them - one request for the whole render - but
      // still before the browser gets round to anything else.
      queueMicrotask(() => { void flush() })
    }
    return () => { live = false; waiters.delete(wake) }
  }, [url, path, projectId, agentId])
  return url ? recallMediaSize(url) : null
}

/** Forget what has been asked - tests only, so one case can't mute the next. */
export function clearServerMediaSizeState(): void {
  pending.clear()
  asked.clear()
  waiters.clear()
  scheduled = false
}
