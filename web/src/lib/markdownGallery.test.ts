import { describe, it, expect, afterEach } from 'vitest'
import { markdownGalleryAt } from './markdownGallery'

// The scoping rule this exists for: an agent's before/after pair lives in ONE
// message, and ←/→ should walk that pair - not the whole transcript, and not
// stop dead on the one image you clicked.

afterEach(() => { document.body.innerHTML = '' })

// Two markdown blocks (two chat messages), the first holding two images.
function renderTranscript() {
  document.body.innerHTML = `
    <div data-md-root="">
      <p>before and after:</p>
      <img data-md-src="/tmp/before@2x.png" src="/blob?path=before@2x.png" alt="before">
      <img data-md-src="/tmp/after.png" src="/blob?path=after.png" alt="after">
    </div>
    <div data-md-root="">
      <img data-md-src="/tmp/other.png" src="/blob?path=other.png" alt="other">
    </div>
  `
  return Array.from(document.querySelectorAll('img'))
}

describe('markdownGalleryAt', () => {
  it('collects the images of the clicked block, in document order', () => {
    const [before, after] = renderTranscript()

    const fromFirst = markdownGalleryAt(before as HTMLImageElement)
    expect(fromFirst.items.map((i) => i.filename)).toEqual(['before', 'after'])
    expect(fromFirst.index).toBe(0)

    // Clicking the second opens the same strip, positioned on it.
    const fromSecond = markdownGalleryAt(after as HTMLImageElement)
    expect(fromSecond.items.map((i) => i.filename)).toEqual(['before', 'after'])
    expect(fromSecond.index).toBe(1)
  })

  it('does not reach into another message', () => {
    const [, , other] = renderTranscript()
    const g = markdownGalleryAt(other as HTMLImageElement)
    expect(g.items.map((i) => i.filename)).toEqual(['other'])
    expect(g.index).toBe(0)
  })

  it('carries each image its own density and its src as authored', () => {
    const [before] = renderTranscript()
    const { items } = markdownGalleryAt(before as HTMLImageElement)
    // Density is read per image off its own path, so a @2x capture beside a 1x
    // one reports the right one in each caption.
    expect(items.map((i) => i.dpi)).toEqual([2, 1])
    // The attribute, not the absolutised .src property.
    expect(items[0].url).toBe('/blob?path=before@2x.png')
  })

  it('skips images that are not rendered markdown (no data-md-src)', () => {
    document.body.innerHTML = `
      <div data-md-root="">
        <img src="/decoration.png" alt="decoration">
        <img data-md-src="/tmp/shot.png" src="/blob?path=shot.png" alt="shot">
      </div>
    `
    const shot = document.querySelector('img[data-md-src]') as HTMLImageElement
    const g = markdownGalleryAt(shot)
    expect(g.items.map((i) => i.filename)).toEqual(['shot'])
    expect(g.index).toBe(0)
  })

  it('falls back to the clicked image alone outside a markdown block', () => {
    document.body.innerHTML = '<img data-md-src="/tmp/loose.png" src="/blob?path=loose.png" alt="loose">'
    const loose = document.querySelector('img') as HTMLImageElement
    const g = markdownGalleryAt(loose)
    expect(g.items).toHaveLength(1)
    expect(g.index).toBe(0)
  })
})
