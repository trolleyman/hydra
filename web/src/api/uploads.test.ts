import { describe, expect, it } from 'vitest'
import { extractFiles, hasFilePayload } from './uploads'

describe('file drag payloads', () => {
  it('recognises WebKit file items without a Files type', () => {
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const transfer = {
      types: ['text/uri-list'],
      files: [] as unknown as FileList,
      items: [{ kind: 'file', type: 'text/plain', getAsFile: () => file }] as unknown as DataTransferItemList,
    } as DataTransfer

    expect(hasFilePayload(transfer)).toBe(true)
    expect(extractFiles(transfer)).toEqual([file])
  })

  it('does not claim an ordinary text drag', () => {
    const transfer = {
      types: ['text/plain'],
      files: [] as unknown as FileList,
      items: [{ kind: 'string', type: 'text/plain' }] as unknown as DataTransferItemList,
    } as DataTransfer
    expect(hasFilePayload(transfer)).toBe(false)
  })
})
