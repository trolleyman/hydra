// The lightbox gallery for the media inside ONE rendered markdown block.
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

// Markdown media tags itself with data-md-src (the path as authored, which
// copy-as-markdown also reads). A picture is an <img>, a recording a <video> -
// both belong in the strip, so a message mixing a screenshot with a clip steps
// through all of it. Media that failed to resolve renders as a chip with no
// element at all, so it is absent here rather than a broken entry in the strip.
const MD_MEDIA_SELECTOR = 'img[data-md-src], video[data-md-src]'

type MdMedia = HTMLImageElement | HTMLVideoElement

function itemFor(el: MdMedia): LightboxItem {
  const video = el instanceof HTMLVideoElement
  // Whichever axis pair this element reports its intrinsic size on. Both are 0
  // until the picture decodes / the clip's metadata arrives, which the spread
  // below treats as "unknown" rather than passing on a zero size.
  const w = video ? el.videoWidth : el.naturalWidth
  const h = video ? el.videoHeight : el.naturalHeight
  return {
    // The attribute, not the .src property: the property resolves to an absolute
    // URL, and the lightbox matches entries against the page's images by the
    // value it was given (see lightboxFlip.findLightboxOrigin, which absolutises
    // both sides itself).
    url: el.getAttribute('src') ?? el.src,
    // A <video> carries no alt; its accessible name is the one MarkdownVideo put
    // on it, which is the same string (the alt text, else the filename).
    filename: (video ? el.getAttribute('aria-label') : el.alt) || (video ? 'video' : 'image'),
    // Markdown media carries no byte size - the caption leaves it out for 0.
    size: 0,
    kind: video ? 'video' : 'image',
    // Per file, off its OWN authored path: a message can mix a @2x capture with
    // a 1x one, and each should report its own density in the caption.
    dpi: densityFromPath(el.dataset.mdSrc),
    // The size is free here - this file is already decoded on the page in front
    // of us, and naturalWidth/videoWidth is its own size whatever box it is drawn
    // in. Handing it over lets the lightbox reserve the box before it loads, so
    // stepping through a message's media with ←/→ doesn't pop each one open.
    ...(w && h ? { width: w, height: h } : null),
  }
}

/**
 * The gallery to open for `el` - a rendered markdown image, or the wrapper around
 * a rendered markdown video: every markdown image and video in the same block, in
 * document order, and `el`'s index in it.
 *
 * Falls back to the clicked media alone when it sits outside a markdown root, or
 * somehow isn't among what was found there - a gallery that didn't contain the
 * file you clicked would open on the wrong one. A null/empty opener (a wrapper
 * ref that never attached) yields an empty gallery, which the lightbox ignores.
 */
export function markdownGalleryAt(el: Element | null): { items: LightboxItem[]; index: number } {
  const media = el?.matches(MD_MEDIA_SELECTOR)
    ? (el as MdMedia)
    : (el?.querySelector<MdMedia>(MD_MEDIA_SELECTOR) ?? null)
  if (!media) return { items: [], index: 0 }
  const root = media.closest('[data-md-root]')
  const all = root ? Array.from(root.querySelectorAll<MdMedia>(MD_MEDIA_SELECTOR)) : []
  const index = all.indexOf(media)
  if (index < 0) return { items: [itemFor(media)], index: 0 }
  return { items: all.map(itemFor), index }
}
