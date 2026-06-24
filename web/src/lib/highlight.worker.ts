// Web Worker that runs highlight.js off the main thread. The diff viewer
// highlights every file's whole content; doing that synchronously during render
// blocks the main thread (a multi-file diff stacks one ~10ms highlight pass per
// file into a single long task). Offloading to this worker keeps the UI thread
// free — files paint as plain text immediately and the colours stream back as
// each highlight completes.
//
// Protocol: the client posts `{ id, lang, old, new }` where `old`/`new` are the
// joined old/new side source (or null), and the worker replies with the same
// `id` plus `old`/`new` as per-line highlighted HTML (string[] or null).
import { highlightLines } from './highlightCore'

export interface HighlightRequest {
  id: number
  lang: string
  old: string | null
  new: string | null
}

export interface HighlightResponse {
  id: number
  old: string[] | null
  new: string[] | null
}

self.onmessage = (e: MessageEvent<HighlightRequest>) => {
  const { id, lang, old, new: nw } = e.data
  const out: HighlightResponse = {
    id,
    old: old != null ? highlightLines(old, lang) : null,
    new: nw != null ? highlightLines(nw, lang) : null,
  }
  ;(self as unknown as Worker).postMessage(out)
}
