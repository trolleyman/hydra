// The lightbox gallery for the images inside ONE rendered markdown block.
//
// An agent that posts a before/after pair posts them in a single message, and
// stepping between them with ←/→ is the whole point of having two. Opening one
// image alone made that impossible; making every image in the transcript one
// gallery would be worse - you would walk out of the message you were reading
// into screenshots from an hour ago. So the gallery is scoped to the markdown
// block the clicked image lives in: <Markdown> marks its own subtree with
// data-md-root, and that is the boundary.
//
// The set is read off the DOM at click time rather than collected during render.
// Document order is exactly DOM order, so there is no ordering bookkeeping to
// get wrong, nothing to register or unregister as a streamed message rewrites
// itself, and the gallery can only ever contain what is actually on screen.

import type { LightboxItem } from '../components/Lightbox'
import { densityFromPath } from './imageDensity'

// Markdown images tag themselves with data-md-src (the path as authored, which
// copy-as-markdown also reads). Images that failed to resolve render as a chip
// with no <img> at all, so they are absent here rather than being broken
// entries in the strip.
const MD_IMAGE_SELECTOR = 'img[data-md-src]'

function itemFor(img: HTMLImageElement): LightboxItem {
  return {
    // The attribute, not the .src property: the property resolves to an absolute
    // URL, and the lightbox matches entries against the page's images by the
    // value it was given (see lightboxFlip.findLightboxOrigin, which absolutises
    // both sides itself).
    url: img.getAttribute('src') ?? img.src,
    filename: img.alt || 'image',
    // Markdown images carry no byte size - the caption leaves it out for 0.
    size: 0,
    // Per image, off its OWN authored path: a message can mix a @2x capture with
    // a 1x one, and each should report its own density in the caption.
    dpi: densityFromPath(img.dataset.mdSrc),
    // The size is free here - this image is decoded on the page in front of us,
    // and naturalWidth is the file's own size whatever box it is drawn in. Handing
    // it over lets the lightbox reserve the picture's box before it loads, so
    // stepping through a message's images with ←/→ doesn't pop each one open.
    ...(img.naturalWidth && img.naturalHeight
      ? { width: img.naturalWidth, height: img.naturalHeight }
      : null),
  }
}

/**
 * The gallery to open when `img` (a rendered markdown image) is clicked: every
 * markdown image in the same block, in document order, and `img`'s index in it.
 *
 * Falls back to the clicked image alone when it sits outside a markdown root, or
 * somehow isn't among the images found there - a gallery that didn't contain the
 * picture you clicked would open on the wrong one.
 */
export function markdownGalleryAt(img: HTMLImageElement): { items: LightboxItem[]; index: number } {
  const root = img.closest('[data-md-root]')
  const imgs = root ? Array.from(root.querySelectorAll<HTMLImageElement>(MD_IMAGE_SELECTOR)) : []
  const index = imgs.indexOf(img)
  if (index < 0) return { items: [itemFor(img)], index: 0 }
  return { items: imgs.map(itemFor), index }
}
