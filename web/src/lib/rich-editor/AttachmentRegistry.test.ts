import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichEditor } from './core'
import { AttachmentRegistry, type UploadedAttachment } from './AttachmentRegistry'

const attachment = { id: 'image-1', name: 'cat.png', kind: 'image', display: 'chip' } as const

function deferredUpload() {
  let resolve!: (value: UploadedAttachment) => void
  const promise = new Promise<UploadedAttachment>((done) => { resolve = done })
  return { promise, resolve }
}

describe('attachment upload lifecycle', () => {
  const editors: ReturnType<typeof createRichEditor>[] = []
  afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

  function editorWith(registry: AttachmentRegistry) {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = createRichEditor({ element, attachmentRegistry: registry })
    editors.push(editor)
    return editor
  }

  it('keeps private file and path data out of the document and Markdown', async () => {
    const pending = deferredUpload()
    const upload = vi.fn(() => pending.promise)
    const registry = new AttachmentRegistry(upload)
    const editor = editorWith(registry)

    const file = new File(['image'], 'cat.png', { type: 'image/png' })
    expect(registry.add(editor, attachment, file)).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'attachment', attrs: attachment }] }],
    })
    expect(editor.storage.markdown.manager.serialize(editor.getJSON())).toBe('[cat.png]')
    expect(JSON.stringify(editor.getJSON())).not.toContain('image/png')

    pending.resolve({ path: '/private/uploads/cat.png' })
    await vi.waitFor(() => expect(registry.get(attachment.id)?.status).toBe('uploaded'))
    expect(JSON.stringify(editor.getJSON())).not.toContain('/private/uploads')
  })

  it('cancels on undo and restarts the upload on redo', () => {
    const signals: AbortSignal[] = []
    const upload = vi.fn((_file: File, _id: string, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<UploadedAttachment>(() => {})
    })
    const registry = new AttachmentRegistry(upload)
    const editor = editorWith(registry)

    registry.add(editor, attachment, new File(['image'], 'cat.png'))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(editor.commands.undo()).toBe(true)
    expect(signals[0].aborted).toBe(true)
    expect(registry.get(attachment.id)).toEqual({ status: 'idle' })

    expect(editor.commands.redo()).toBe(true)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(signals[1].aborted).toBe(false)
  })
})
