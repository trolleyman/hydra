import { describe, expect, it } from 'vitest'
import { parseUploadAttachments } from './uploadAttachments'

describe('parseUploadAttachments', () => {
  it('lifts uploads from the per-project state tree into attachment chips', () => {
    const path = '/home/u/.hydra/local/projects/hydra/uploads/1788109758389757016-image1.png'
    const parsed = parseUploadAttachments(`Please inspect this.\n${path}`, 'hydra')

    expect(parsed.text).toBe('Please inspect this.')
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]).toMatchObject({
      filename: 'image1.png',
      path,
      url: '/api/projects/hydra/uploads/blob?name=1788109758389757016-image1.png',
      previewUrl: '/api/projects/hydra/uploads/blob?name=1788109758389757016-image1.png',
    })
  })

  it('accepts uploads below a configurable state root and legacy project-local uploads', () => {
    const current = '/var/lib/hydra/projects/p1/uploads/1788109758389757017-notes.txt'
    const legacy = '/repo/.hydra/local/uploads/1788109758389757018-old.png'
    const parsed = parseUploadAttachments(`${current}\n${legacy}`, 'p1')

    expect(parsed.text).toBe('')
    expect(parsed.attachments.map((attachment) => attachment.path)).toEqual([current, legacy])
  })

  it('does not lift an ordinary file merely because its directory is named uploads', () => {
    const path = '/repo/src/uploads/fixture.png'
    const parsed = parseUploadAttachments(`Review ${path}`, 'p1')

    expect(parsed).toEqual({ text: `Review ${path}`, attachments: [] })
  })
})
