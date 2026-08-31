// Clipboard helpers. Text goes through copyText (below) because a plain
// navigator.clipboard.writeText does NOT work everywhere Hydra runs; images go
// through copyImageToClipboard because the async Clipboard API only reliably
// accepts image/png, so other formats have to be rasterized first and support
// varies by browser/context.

// copyText writes plain text to the clipboard and reports whether it landed.
//
// navigator.clipboard only exists in a *secure context* (https, or a localhost
// origin). Hydra is routinely reached over plain http via a LAN hostname (e.g.
// http://hades:26600), where navigator.clipboard is undefined entirely - so a
// bare navigator.clipboard.writeText throws, and an optional-chained
// navigator.clipboard?.writeText silently no-ops. Both present as "copy does
// nothing" (the macOS-over-LAN report), so callers must not use writeText
// directly. Fall back to the legacy execCommand('copy') over a hidden textarea,
// which still works in an insecure context. Callers await the boolean to drive
// their own success/failure UI (tick, toast, ...).
export async function copyText(text: string): Promise<boolean> {
  // WebKitGTK exposes navigator.clipboard.writeText, but its implementation can
  // attempt a GTK write without a MIME type. That logs a GTK critical and loses
  // the copy. The legacy route selects a textarea, so WebKit supplies
  // text/plain itself. Keep the async route for browsers and the other desktop
  // shells where it is reliable.
  if (!isWebKitGTKDesktop() && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or a transient failure - fall through and try the
      // legacy path before giving up.
    }
  }
  return legacyCopy(text)
}

function isWebKitGTKDesktop(): boolean {
  return navigator.userAgent.includes('Linux') &&
    !!(window as { webkit?: { messageHandlers?: { hydra?: unknown } } }).webkit?.messageHandlers?.hydra
}

// legacyCopy is the insecure-context / old-browser fallback: drop a hidden,
// off-screen textarea, select it, and let the synchronous execCommand('copy')
// lift the selection onto the clipboard. It must run inside a user gesture (a
// click / keydown), which every copyText caller is. Returns false rather than
// throwing so copyText's contract stays boolean-only.
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  // readonly stops the mobile keyboard popping up; the fixed off-screen, zero-
  // opacity placement keeps it out of layout and invisible while still
  // selectable. It's removed again before we return, so it never reflows content.
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  ta.style.pointerEvents = 'none'
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
  }
}

// canCopyImages reports whether this browser/context can write images to the
// clipboard. The async Clipboard API needs a secure context (https or localhost)
// plus navigator.clipboard.write + the ClipboardItem constructor - none of which
// exist in older or insecure setups. Callers use this to hide the copy button
// when image copy can't work, rather than offering a control that always fails.
export function canCopyImages(): boolean {
  return (
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard?.write
  )
}

// copyImageToClipboard fetches an image URL and writes it to the clipboard as
// PNG. The Clipboard API only reliably accepts image/png across browsers, so
// anything else (jpeg/gif/webp/svg/...) is rasterized to PNG via a canvas first.
// The PNG is produced lazily inside the ClipboardItem because Safari requires
// write() to be invoked synchronously within the originating user gesture; it
// (and Chromium) accept a Promise value and resolve it afterwards.
export async function copyImageToClipboard(url: string): Promise<void> {
  const png = (async () => {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    return blob.type === 'image/png' ? blob : rasterizeToPng(blob)
  })()
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

// rasterizeToPng decodes an image blob into a canvas and re-encodes it as PNG,
// so a non-PNG source can still be placed on the clipboard. Same-origin blobs
// don't taint the canvas, so toBlob() succeeds.
function rasterizeToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || img.width
      canvas.height = img.naturalHeight || img.height
      const ctx = canvas.getContext('2d')
      if (!ctx || canvas.width === 0 || canvas.height === 0) {
        URL.revokeObjectURL(objUrl)
        reject(new Error('cannot rasterize image'))
        return
      }
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(objUrl)
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('canvas toBlob failed'))), 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(objUrl)
      reject(new Error('failed to load image'))
    }
    img.src = objUrl
  })
}
