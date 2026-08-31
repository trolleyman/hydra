import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichEditor } from './RichEditorCore'
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

  function editorWith(registry: AttachmentRegistry, onOpenAttachment?: (id: string, origin: Element) => void) {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = createRichEditor({ element, attachmentRegistry: registry, onOpenAttachment })
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

  it('retries failed uploads and exposes only resolved document paths', async () => {
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ path: '/uploads/cat.png' })
    const registry = new AttachmentRegistry(upload)
    const editor = editorWith(registry)

    registry.add(editor, attachment, new File(['image'], 'cat.png'))
    await vi.waitFor(() => expect(registry.get(attachment.id)?.status).toBe('failed'))
    expect(registry.uploadedPaths(editor)).toEqual([])
    expect(registry.retry(attachment.id)).toBe(true)
    await vi.waitFor(() => expect(registry.get(attachment.id)?.status).toBe('uploaded'))
    expect(registry.uploadedPaths(editor)).toEqual(['/uploads/cat.png'])
  })

  it('renders upload state and removal inside the document chip', async () => {
    const registry = new AttachmentRegistry(() => new Promise(() => {}))
    const editor = editorWith(registry)
    registry.add(editor, attachment, new File(['image'], 'cat.png'))

    const chip = editor.view.dom.querySelector<HTMLElement>('[data-composer-attachment]')!
    expect(chip.dataset.uploadState).toBe('uploading')
    expect(chip.querySelector('[aria-label="Remove cat.png"]')).not.toBeNull()
    chip.querySelector<HTMLButtonElement>('[aria-label="Remove cat.png"]')!.click()
    expect(editor.getJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('opens an editable image chip without selecting inside the atom', () => {
    const registry = new AttachmentRegistry(() => new Promise(() => {}))
    const onOpen = vi.fn()
    const editor = editorWith(registry, onOpen)
    registry.add(editor, { ...attachment, display: 'thumbnail' }, new File(['image'], 'cat.png'), 'blob:cat')

    const chip = editor.view.dom.querySelector<HTMLElement>('[data-composer-attachment]')!
    expect(chip.querySelector<HTMLImageElement>('.composer-attachment-preview')?.src).toBe('blob:cat')
    chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(onOpen).toHaveBeenCalledWith('image-1', chip)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('shows a thumbnail when its preview URL arrives after the node view mounts', () => {
    const registry = new AttachmentRegistry(() => new Promise(() => {}))
    const editor = editorWith(registry)
    registry.add(editor, { ...attachment, display: 'thumbnail' }, new File(['image'], 'cat.png'))

    const preview = editor.view.dom.querySelector<HTMLImageElement>('.composer-attachment-preview')!
    expect(preview.hidden).toBe(true)
    registry.registerUploaded({ ...attachment, display: 'thumbnail' }, { path: '/uploads/cat.png' }, 'blob:cat')
    expect(preview.hidden).toBe(false)
    expect(preview.src).toBe('blob:cat')
  })
})
