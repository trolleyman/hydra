// File uploads for pasted/attached prompt assets.
//
// The generated OpenAPI client only handles JSON bodies, so uploads use a raw
// multipart request against the same-origin /uploads endpoint (proxied to the
// backend in dev — see vite.config.ts). The backend stores the file under the
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

const IMAGE_RE = /^image\//

/**
 * Pulls real files out of a clipboard/drag DataTransfer.
 *
 * `items` (kind "file") and `files` often BOTH carry the same pasted screenshot
 * on Chromium browsers, so we must not naively union them: each source yields a
 * distinct File object stamped with its own `lastModified` (set when the object
 * is materialized). Those stamps usually match, but if a millisecond boundary is
 * crossed between reading the two lists they differ by 1ms and any dedupe keyed
 * on `lastModified` lets the duplicate through — pasting one image twice.
 *
 * So we prefer `items` (the reliable source for pastes) and only fall back to
 * `files` when `items` yielded nothing — some browsers populate only `files`.
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
