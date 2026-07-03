// Clipboard helpers for copying images. Text copy is a one-liner
// (navigator.clipboard.writeText) and doesn't need wrapping, but images do: the
// async Clipboard API only reliably accepts image/png, so other formats have to
// be rasterized first, and support varies by browser/context.

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
