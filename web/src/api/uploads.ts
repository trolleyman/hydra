// File uploads for pasted/attached prompt assets.
//
// The generated OpenAPI client only handles JSON bodies, so uploads use a raw
// multipart request against the same-origin /uploads endpoint (proxied to the
// backend in dev - see vite.config.ts). The backend stores the file under the
// project's .hydra/local/uploads dir and returns its absolute path, which is valid
// both on the host and inside the agent sandbox. Inserting that path into the
// prompt/terminal lets the agent read the file directly.

export interface UploadResult {
  /** Absolute path of the stored file, readable by the agent. */
  path: string
  /** Sanitized on-disk filename. */
  filename: string
}

export async function uploadFile(projectId: string | null, file: File): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file, file.name || 'paste')
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  const res = await fetch(`/uploads/projects/${pid}`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text.trim() || `upload failed (${res.status})`)
  }
  return (await res.json()) as UploadResult
}

// URL that serves a stored upload's bytes by its on-disk filename, so the UI can
// render an image attachment (thumbnail + lightbox) for a path embedded in an
// already-submitted prompt. Backed by GET /uploads/projects/{id}/blob.
export function uploadBlobUrl(projectId: string | null, filename: string): string {
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  return `/uploads/projects/${pid}/blob?name=${encodeURIComponent(filename)}`
}

// URL that serves a file an agent referenced by path in a chat message (a
// screenshot it wrote to its worktree or to /tmp). The path is sent exactly as
// the agent wrote it; the backend translates it to its host location and serves
// it only if it lands inside that head's worktree, private /tmp, or the project's
// uploads dir. Backed by GET /agent-files/projects/{id}/agents/{id}/blob.
export function agentFileUrl(projectId: string, agentId: string, path: string): string {
  const pid = encodeURIComponent(projectId)
  const aid = encodeURIComponent(agentId)
  return `/agent-files/projects/${pid}/agents/${aid}/blob?path=${encodeURIComponent(path)}`
}

/**
 * Natural pixel sizes for a batch of agent-referenced image paths, read off each
 * file's header by the backend - so a chat picture's box can be reserved before
 * its bytes are fetched, instead of the browser having to download the image to
 * find out how tall it is. Backed by POST .../agents/{id}/sizes.
 *
 * A path the backend can't measure (gone, unreadable, a format its decoders don't
 * cover) is simply MISSING from the result rather than zero - the caller falls
 * back to measuring the image itself. A failed request is the same thing for
 * every path at once, so it resolves to an empty map rather than throwing: this
 * is an optimisation, and the fallback is the behaviour that existed before it.
 */
export async function fetchAgentFileSizes(
  projectId: string,
  agentId: string,
  paths: string[],
): Promise<Record<string, { width: number; height: number }>> {
  if (paths.length === 0) return {}
  const pid = encodeURIComponent(projectId)
  const aid = encodeURIComponent(agentId)
  try {
    const res = await fetch(`/agent-files/projects/${pid}/agents/${aid}/sizes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    if (!res.ok) return {}
    const body = (await res.json()) as { sizes?: Record<string, { width: number; height: number }> }
    return body.sizes ?? {}
  } catch {
    return {}
  }
}

const IMAGE_RE = /^image\//

/**
 * Pulls real files out of a clipboard/drag DataTransfer.
 *
 * `items` (kind "file") and `files` often BOTH carry the same pasted screenshot
 * on Chromium browsers, so we must not naively union them: each source yields a
 * distinct File object stamped with its own `lastModified` (set when the object
 * is materialized). Those stamps usually match, but if a millisecond boundary is
 * crossed between reading the two lists they differ by 1ms and any dedupe keyed
 * on `lastModified` lets the duplicate through - pasting one image twice.
 *
 * So we prefer `items` (the reliable source for pastes) and only fall back to
 * `files` when `items` yielded nothing - some browsers populate only `files`.
 * A `seen` set still guards against duplicates within a single source.
 */
export function extractFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  const seen = new Set<string>()
  const add = (f: File | null) => {
    if (!f) return
    const key = `${f.name}:${f.size}:${f.type}:${f.lastModified}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(f)
  }
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') add(item.getAsFile())
    }
  }
  if (out.length === 0 && dt.files) {
    for (const f of Array.from(dt.files)) add(f)
  }
  return out
}

export function isImageFile(file: File): boolean {
  return IMAGE_RE.test(file.type)
}
