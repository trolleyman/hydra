import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { clearMediaSizes, discoverMediaSize, recallMediaSize, rememberMediaSize } from './mediaSize'

// The size cache behind the lightbox's reserved picture box. Two things have to
// hold for it to be worth having: the same file written two ways has to be ONE
// entry (a markdown image is a relative path, an artifact url is absolute), and a
// size must never be invented - a wrong box is worse than no box, since it lays
// the picture out at a shape it then has to jump out of.
describe('mediaSize', () => {
  beforeEach(() => clearMediaSizes())
  afterEach(() => {
    clearMediaSizes()
    document.body.innerHTML = ''
  })

  it('recalls what it was told', () => {
    rememberMediaSize('/uploads/shot.png', 1440, 880)
    expect(recallMediaSize('/uploads/shot.png')).toEqual({ w: 1440, h: 880 })
  })

  it('treats a relative and an absolute spelling of one file as the same entry', () => {
    rememberMediaSize('/uploads/shot.png', 1440, 880)
    expect(recallMediaSize(`${window.location.origin}/uploads/shot.png`)).toEqual({ w: 1440, h: 880 })
  })

  it('knows nothing about a file it has not seen', () => {
    expect(recallMediaSize('/uploads/other.png')).toBeNull()
  })

  it('ignores a size that is not one', () => {
    // What an element that has not decoded yet reports - remembering it would
    // hand the lightbox a 0x0 box to lay the picture out in.
    rememberMediaSize('/uploads/shot.png', 0, 0)
    rememberMediaSize('/uploads/shot.png', NaN, 10)
    expect(recallMediaSize('/uploads/shot.png')).toBeNull()
  })

  it('ignores an empty url rather than caching one entry for all of them', () => {
    rememberMediaSize('', 10, 10)
    expect(recallMediaSize('')).toBeNull()
    expect(recallMediaSize(undefined)).toBeNull()
  })

  it('does not walk the page on a plain recall - that is discoverMediaSize\'s job', () => {
    // recallMediaSize is called from renders, so it stays a map lookup.
    const img = document.createElement('img')
    img.src = '/uploads/chip.png'
    Object.defineProperty(img, 'complete', { value: true })
    Object.defineProperty(img, 'naturalWidth', { value: 780 })
    Object.defineProperty(img, 'naturalHeight', { value: 1688 })
    document.body.appendChild(img)
    expect(recallMediaSize('/uploads/chip.png')).toBeNull()
    expect(discoverMediaSize('/uploads/chip.png')).toEqual({ w: 780, h: 1688 })
    // ...and having found it once, the cheap read knows it too.
    expect(recallMediaSize('/uploads/chip.png')).toEqual({ w: 780, h: 1688 })
  })

  it('reads the size off a copy already decoded in the page', () => {
    // The case that covers markdown images and attachment chips, which carry no
    // metadata: the thumbnail that was clicked is still on the page behind the
    // overlay, and naturalWidth is the FILE's size whatever box it is drawn in.
    const img = document.createElement('img')
    img.src = '/uploads/chip.png'
    Object.defineProperty(img, 'complete', { value: true })
    Object.defineProperty(img, 'naturalWidth', { value: 780 })
    Object.defineProperty(img, 'naturalHeight', { value: 1688 })
    document.body.appendChild(img)
    expect(discoverMediaSize('/uploads/chip.png')).toEqual({ w: 780, h: 1688 })
  })

  it('ignores a copy in the page that has not decoded yet', () => {
    const img = document.createElement('img')
    img.src = '/uploads/pending.png'
    Object.defineProperty(img, 'complete', { value: false })
    Object.defineProperty(img, 'naturalWidth', { value: 0 })
    Object.defineProperty(img, 'naturalHeight', { value: 0 })
    document.body.appendChild(img)
    expect(discoverMediaSize('/uploads/pending.png')).toBeNull()
  })
})
