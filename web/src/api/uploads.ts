// File uploads for pasted/attached prompt assets.
//
// The generated OpenAPI client only handles JSON bodies, so uploads use a raw
// multipart request against the same-origin POST /api/projects/{id}/uploads
// route (documented in api/openapi.yaml under the `manual` tag, hand-served
// because of the multipart body). The backend stores the file under the project's
// directory in Hydra's state root and returns its absolute path, which is valid
// both on the host and inside the agent sandbox. Inserting that path into the
// prompt/terminal lets the agent read the file directly.

import type { UploadResponse } from './models/UploadResponse'
import { OpenAPI } from './core/OpenAPI'

// From the spec, not hand-copied - see the note in folderPicker.ts. `path` is the
// absolute host path (readable by the agent), `filename` the sanitized on-disk name.
export type UploadResult = UploadResponse

export async function uploadFile(projectId: string | null, file: File): Promise<UploadResult> {
  if (!projectId) throw new Error('Select a project before attaching files')
  const form = new FormData()
  form.append('file', file, file.name || 'paste')
  const pid = encodeURIComponent(projectId)
  // Keep raw multipart uploads on the same configured API origin as generated
  // client calls. A relative URL works only when the SPA and API share an
  // origin; desktop/reverse-proxy deployments can give the UI a different one,
  // where it otherwise answers this POST with its own 404 page.
  const res = await fetch(`${OpenAPI.BASE}/api/projects/${pid}/uploads`, {
    method: 'POST',
    body: form,
    credentials: OpenAPI.CREDENTIALS,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text.trim() || `upload failed (${res.status})`)
  }
  return (await res.json()) as UploadResult
}

// URL that serves a stored upload's bytes by its on-disk filename, so the UI can
// render an image attachment (thumbnail + lightbox) for a path embedded in an
// already-submitted prompt. Backed by GET /api/projects/{id}/uploads/blob.
export function uploadBlobUrl(projectId: string | null, filename: string): string {
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  return `/api/projects/${pid}/uploads/blob?name=${encodeURIComponent(filename)}`
}

// URL that serves a file an agent referenced by path in a chat message (a
// screenshot it wrote to its worktree or to /tmp). The path is sent exactly as
// the agent wrote it; the backend translates it to its host location and serves
// it only if it lands inside that head's worktree, private /tmp, or the project's
// uploads dir. Backed by GET /api/projects/{id}/agents/{agent_id}/media/blob.
export function agentFileUrl(projectId: string, agentId: string, path: string): string {
  const pid = encodeURIComponent(projectId)
  const aid = encodeURIComponent(agentId)
  return `/api/projects/${pid}/agents/${aid}/media/blob?path=${encodeURIComponent(path)}`
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

// WebKitGTK can advertise a filesystem drag through file-kind items while its
// `types` list contains only text/uri-list. Looking only for the Chromium-style
// "Files" type lets the browser perform its default drop, which inserts a local
// path as text instead of handing Hydra the file bytes. The item/file lists are
// the stronger signal and cover images and every other attachment type.
export function hasFilePayload(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (dt.files?.length > 0) return true
  if (dt.items && Array.from(dt.items).some((item) => item.kind === 'file')) return true
  return Array.from(dt.types).some((type) => type.toLowerCase() === 'files')
}

export function isImageFile(file: File): boolean {
  return IMAGE_RE.test(file.type)
}
