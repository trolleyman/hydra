import { ClipboardCheck, ClipboardX } from 'lucide-react'
import { useToastStore } from '../stores/toastStore'
import { copyText } from './clipboard'

// The one shape every "you copied something" toast uses: a short title line
// naming WHAT was copied, and the copied value itself underneath as a code
// block. The value is what you'd want to eyeball ("did I grab the right
// branch?"), and it is code-ish (a branch name, a shell command, a URL), so it
// belongs in the toast's mono block rather than run into the sentence.
//
// `what` is the noun phrase after "Copied" / "Failed to copy" - e.g. 'branch
// name' gives "Copied branch name" and "Failed to copy branch name".
export interface CopyToastOptions {
  // The noun phrase naming what was copied (lower case, no trailing period).
  what: string
  // Language tag for the code block (e.g. 'bash'), when the value is code in a
  // language worth colouring. Omit for a plain block (branch names, URLs).
  lang?: string
  // What to SHOW in the code block, when the raw text is too long or noisy to
  // display verbatim (e.g. a multi-line terminal selection). Defaults to the
  // copied text itself.
  preview?: string
}

// MAX_PREVIEW_CHARS / MAX_PREVIEW_LINES bound an unbounded copy (a terminal
// selection, a whole file) so the toast stays a confirmation rather than a
// second view of the content. The block scrolls, but a toast you have to scroll
// isn't telling you anything at a glance.
const MAX_PREVIEW_CHARS = 240
const MAX_PREVIEW_LINES = 4

// clampPreview trims a copied value down to something a toast can show at a
// glance, marking the cut with an ellipsis so it never reads as the whole value.
export function clampPreview(text: string): string {
  const lines = text.split('\n')
  let out = lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES).join('\n') + '\n...' : text
  if (out.length > MAX_PREVIEW_CHARS) out = out.slice(0, MAX_PREVIEW_CHARS).trimEnd() + '...'
  return out
}

// copyWithToast writes text to the clipboard and confirms with the standard copy
// toast (see CopyToastOptions). Goes through copyText so it also works on
// insecure LAN origins, where navigator.clipboard is undefined - and so the
// toast reports the TRUE outcome rather than assuming the write landed.
// Resolves to whether the copy landed, so a caller with its own copy button can
// flash a tick or an X to match.
export function copyWithToast(text: string, opts: CopyToastOptions): Promise<boolean> {
  return copyText(text).then((ok) => {
    showCopyToast(ok, text, opts)
    return ok
  })
}

// showCopyToast raises the copy toast for a write the caller made itself (e.g.
// an image copied through copyImageToClipboard, or a terminal selection copied
// as a side effect of a key handler).
export function showCopyToast(ok: boolean, text: string, opts: CopyToastOptions) {
  useToastStore.getState().show({
    // A clipboard glyph rather than the type's tick/cross: the toast is about
    // the clipboard, and the icon says so at a glance.
    icon: ok ? <ClipboardCheck className="w-[18px] h-[18px]" /> : <ClipboardX className="w-[18px] h-[18px]" />,
    message: ok ? `Copied ${opts.what}` : `Failed to copy ${opts.what}`,
    code: clampPreview(opts.preview ?? text),
    codeLang: opts.lang,
    type: ok ? 'success' : 'error',
    // A confirmation is read in a glance; a failure carries the reason to act
    // on, so it keeps the store's longer error lifetime.
    ...(ok ? { duration: 2500 } : {}),
  })
}
