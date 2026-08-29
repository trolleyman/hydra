import type { Editor } from '@tiptap/core'
import { attachmentIds, insertAttachment, type ComposerAttachment } from './Attachment'

export interface UploadedAttachment {
  path: string
}

export type AttachmentUpload = (file: File, id: string, signal: AbortSignal) => Promise<UploadedAttachment>
export type AttachmentUploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'uploaded'; uploaded: UploadedAttachment }
  | { status: 'failed'; error: unknown }

interface RegistryEntry {
  attachment: ComposerAttachment
  file: File
  state: AttachmentUploadState
  controller?: AbortController
  generation: number
}

export class AttachmentRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly listeners = new Set<() => void>()
  private editor?: Editor
  private onTransaction?: () => void

  constructor(private readonly upload: AttachmentUpload) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(id: string): AttachmentUploadState | undefined {
    return this.entries.get(id)?.state
  }

  attachment(id: string): ComposerAttachment | undefined {
    return this.entries.get(id)?.attachment
  }

  retry(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.state.status !== 'failed' || !this.editor) return false
    entry.state = { status: 'idle' }
    this.emit()
    this.reconcile(this.editor)
    return true
  }

  uploadedPaths(editor: Editor): string[] {
    const present = attachmentIds(editor)
    const paths: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name !== 'attachment' || typeof node.attrs.id !== 'string' || !present.has(node.attrs.id)) return
      const state = this.entries.get(node.attrs.id)?.state
      if (state?.status === 'uploaded') paths.push(state.uploaded.path)
    })
    return paths
  }

  hasUploading(editor: Editor): boolean {
    const present = attachmentIds(editor)
    return [...present].some((id) => this.entries.get(id)?.state.status === 'uploading')
  }

  add(editor: Editor, attachment: ComposerAttachment, file: File): boolean {
    if (this.entries.has(attachment.id)) throw new Error(`Duplicate attachment id: ${attachment.id}`)
    this.entries.set(attachment.id, { attachment, file, state: { status: 'idle' }, generation: 0 })
    const inserted = insertAttachment(editor, attachment)
    if (!inserted) this.entries.delete(attachment.id)
    this.reconcile(editor)
    return inserted
  }

  bind(editor: Editor): () => void {
    this.unbind()
    this.editor = editor
    this.onTransaction = () => this.reconcile(editor)
    editor.on('transaction', this.onTransaction)
    this.reconcile(editor)
    return () => this.unbind()
  }

  unbind(): void {
    if (this.editor && this.onTransaction) this.editor.off('transaction', this.onTransaction)
    for (const entry of this.entries.values()) entry.controller?.abort()
    this.editor = undefined
    this.onTransaction = undefined
  }

  private reconcile(editor: Editor): void {
    const present = attachmentIds(editor)
    for (const [id, entry] of this.entries) {
      if (!present.has(id)) {
        if (entry.state.status === 'uploading') {
          entry.controller?.abort()
          entry.controller = undefined
          entry.state = { status: 'idle' }
          this.emit()
        }
        continue
      }
      if (entry.state.status === 'idle') this.start(id, entry)
    }
  }

  private start(id: string, entry: RegistryEntry): void {
    const controller = new AbortController()
    const generation = ++entry.generation
    entry.controller = controller
    entry.state = { status: 'uploading' }
    this.emit()
    void this.upload(entry.file, id, controller.signal).then(
      (uploaded) => {
        if (controller.signal.aborted || generation !== entry.generation) return
        entry.controller = undefined
        entry.state = { status: 'uploaded', uploaded }
        this.emit()
      },
      (error: unknown) => {
        if (controller.signal.aborted || generation !== entry.generation) return
        entry.controller = undefined
        entry.state = { status: 'failed', error }
        this.emit()
      },
    )
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
