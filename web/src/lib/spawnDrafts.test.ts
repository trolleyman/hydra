import { describe, it, expect } from 'vitest'
import { isGenericImageName, nextGenericImageNumber, type Attachment } from './spawnDrafts'

function att(filename: string): Attachment {
  return { id: 0, filename, path: null, size: 0, uploading: false }
}

describe('isGenericImageName', () => {
  it('is true for nameless / "image" stems, false for real names', () => {
    expect(isGenericImageName('image.png')).toBe(true)
    expect(isGenericImageName('IMAGE.PNG')).toBe(true)
    expect(isGenericImageName('.png')).toBe(true) // no stem (bare extension)
    expect(isGenericImageName('diagram.png')).toBe(false)
    expect(isGenericImageName('image7.png')).toBe(false) // already numbered - keep
  })
})

describe('nextGenericImageNumber', () => {
  it('starts at 1 when there are no attachments (resets after send)', () => {
    expect(nextGenericImageNumber([])).toBe(1)
    expect(nextGenericImageNumber([att('diagram.png'), att('notes.md')])).toBe(1)
  })

  it('is max(existing image<N>) + 1, not a running counter', () => {
    expect(nextGenericImageNumber([att('image1.png'), att('image2.png')])).toBe(3)
    // A gap after a removal is filled by max+1, not the old high-water mark.
    expect(nextGenericImageNumber([att('image1.png'), att('image3.png')])).toBe(4)
    // Non-image / oddly-named files are ignored.
    expect(nextGenericImageNumber([att('image5.png'), att('diagram.png'), att('pasted-text-2.txt')])).toBe(6)
  })

  it('reuses a freed low number when the higher one was removed', () => {
    // Had image1 + image2, removed image2 -> only image1 remains -> next is 2.
    expect(nextGenericImageNumber([att('image1.png')])).toBe(2)
  })
})
