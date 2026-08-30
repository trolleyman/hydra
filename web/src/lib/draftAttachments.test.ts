import { describe, it, expect, beforeEach } from 'vitest'
import { attachmentFromPath, hydrateAttachments, serializeAttachments } from './draftAttachments'
import { loadAttachments, saveAttachments, type Attachment } from './spawnDrafts'
import { loadChatAttachments, saveChatAttachments } from './chatDrafts'

// A composer draft's attachments used to be memory-only, so a reload restored
// the typed text with its "[image1.png]" markers and nothing behind them. The
// bytes were on the server the whole time - these cover storing the path and
// rebuilding the chip from it.

const UPLOAD = '/state/projects/proj/uploads/1785321197272323733-image1.png'

function settled(over: Partial<Attachment> = {}): Attachment {
  return { id: 1, filename: 'image1.png', path: UPLOAD, size: 42, uploading: false, ...over }
}

beforeEach(() => localStorage.clear())

describe('attachmentFromPath', () => {
  it('serves an image back from the blob endpoint, thumbnail and all', () => {
    const a = attachmentFromPath(UPLOAD, 'proj')
    expect(a.path).toBe(UPLOAD)
    // The "<unixnano>-" prefix uniqueUploadName adds is dropped for the label.
    expect(a.filename).toBe('image1.png')
    expect(a.url).toContain('/api/projects/proj/uploads/blob?name=')
    expect(a.previewUrl).toBe(a.url)
    expect(a.uploading).toBe(false)
  })

  it('gives a non-image a source but no thumbnail', () => {
    const a = attachmentFromPath('/state/projects/proj/uploads/9-notes.txt', 'proj')
    expect(a.url).toBeTruthy()
    expect(a.previewUrl).toBeUndefined()
  })

  it('hands out distinct ids, so a restored chip cannot collide with a new one', () => {
    expect(attachmentFromPath(UPLOAD, 'proj').id).not.toBe(attachmentFromPath(UPLOAD, 'proj').id)
  })
})

describe('serializeAttachments', () => {
  it('keeps settled uploads and drops the ones with nothing to come back from', () => {
    const stored = serializeAttachments([
      settled(),
      // Still uploading, and a failed upload: neither has a path on the server.
      { id: 2, filename: 'wip.png', path: null, size: 1, uploading: true },
      { id: 3, filename: 'bad.png', path: null, size: 1, uploading: false, error: 'boom' },
    ])
    expect(stored).toEqual([{ filename: 'image1.png', path: UPLOAD, size: 42 }])
  })

  it('returns null when nothing survives, so the caller clears the key', () => {
    expect(serializeAttachments([])).toBeNull()
    expect(serializeAttachments([{ id: 1, filename: 'wip.png', path: null, size: 1, uploading: true }])).toBeNull()
  })
})

describe('hydrateAttachments', () => {
  it('round-trips a settled attachment', () => {
    const [a] = hydrateAttachments(serializeAttachments([settled()]), 'proj')
    expect(a.path).toBe(UPLOAD)
    expect(a.filename).toBe('image1.png')
    expect(a.size).toBe(42)
    expect(a.previewUrl).toBeTruthy()
  })

  it('drops junk rather than crashing the composer it is restoring', () => {
    expect(hydrateAttachments(null, 'proj')).toEqual([])
    expect(hydrateAttachments('nonsense', 'proj')).toEqual([])
    expect(hydrateAttachments([{ filename: 'x' }, null, 7, { path: '' }], 'proj')).toEqual([])
  })
})

describe('spawn + chat draft caches', () => {
  it('writes the spawn box to both tiers, and reads the live one first', () => {
    saveAttachments('proj', false, [settled()])
    // The live tier answers with the chip exactly as the form had it.
    expect(loadAttachments('proj', false)[0].id).toBe(1)
    // The durable tier holds enough on its own to rebuild it after a reload,
    // which drops the module cache but keeps localStorage.
    const stored = localStorage.getItem('hydra-prompt-attachments-full-proj')
    expect(stored).toBeTruthy()
    expect(hydrateAttachments(JSON.parse(stored as string), 'proj')[0].path).toBe(UPLOAD)

    // Clearing the box clears both tiers.
    saveAttachments('proj', false, [])
    expect(localStorage.getItem('hydra-prompt-attachments-full-proj')).toBeNull()
    expect(loadAttachments('proj', false)).toEqual([])
  })

  it('stores chat attachments beside the chat draft text', () => {
    saveChatAttachments('proj', 'agent-1', [settled()])
    expect(loadChatAttachments('proj', 'agent-1')[0].path).toBe(UPLOAD)
    // Written into the agent's view-prefs entry, so it shares the draft's TTL.
    const raw = localStorage.getItem('hydra-agent-view-proj-agent-1')
    expect(raw).toContain(UPLOAD)

    saveChatAttachments('proj', 'agent-1', [])
    expect(loadChatAttachments('proj', 'agent-1')).toEqual([])
    expect(localStorage.getItem('hydra-agent-view-proj-agent-1')).not.toContain(UPLOAD)
  })
})
