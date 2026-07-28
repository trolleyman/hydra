// Web Worker that runs highlight.js off the main thread. The diff viewer
// highlights every file's whole content; doing that synchronously during render
// blocks the main thread (a multi-file diff stacks one ~10ms highlight pass per
// file into a single long task). Offloading to this worker keeps the UI thread
// free - files paint as plain text immediately and the colours stream back as
// each highlight completes.
//
// Protocol: the client posts `{ id, lang, old, new }` where `old`/`new` are the
// joined old/new side source (or null), and the worker replies with the same
// `id` plus `old`/`new` as per-line highlighted HTML (string[] or null).
import { highlightLines } from './highlightCore'
import { ensureLanguage } from './prismLazy'

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

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const { id, lang, old, new: nw } = e.data
  // Fetch + register the grammar on demand if it isn't one of the eager languages
  // (no-op for eager/already-loaded/unknown ones). Highlighting here is already
  // async from the caller's view, so this adds no main-thread cost.
  await ensureLanguage(lang)
  const out: HighlightResponse = {
    id,
    old: old != null ? highlightLines(old, lang) : null,
    new: nw != null ? highlightLines(nw, lang) : null,
  }
  ;(self as unknown as Worker).postMessage(out)
}
