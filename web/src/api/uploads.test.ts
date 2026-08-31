import { describe, expect, it } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAPI } from './core/OpenAPI'
import { extractFiles, hasFilePayload, uploadFile } from './uploads'

afterEach(() => {
  OpenAPI.BASE = ''
  OpenAPI.CREDENTIALS = 'include'
  vi.unstubAllGlobals()
})

describe('uploadFile', () => {
  it('uses the generated client API origin instead of the page origin', async () => {
    OpenAPI.BASE = 'https://api.example.test'
    OpenAPI.CREDENTIALS = 'same-origin'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: '/uploads/x.png', filename: 'x.png' })))
    vi.stubGlobal('fetch', fetchMock)

    await uploadFile('hydra', new File(['png'], 'image.png', { type: 'image/png' }))

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/projects/hydra/uploads',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })

  it('does not request a placeholder route without a project', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadFile(null, new File(['png'], 'image.png', { type: 'image/png' })))
      .rejects.toThrow('Select a project before attaching files')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

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
