import { Node, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { AttachmentRegistry } from './AttachmentRegistry'

export const ATTACHMENT_NAME = 'attachment'

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'archive' | 'file'
export type AttachmentDisplay = 'chip' | 'thumbnail' | 'preview'

export interface ComposerAttachment {
  id: string
  name: string
  kind: AttachmentKind
  display: AttachmentDisplay
}

export interface AttachmentOptions {
  registry?: AttachmentRegistry
  onOpen?: (id: string, origin: Element) => void
}

export const Attachment = Node.create<AttachmentOptions>({
  name: ATTACHMENT_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { registry: undefined, onOpen: undefined }
  },

  addAttributes() {
    return {
      id: { default: null },
      name: { default: '' },
      kind: { default: 'file' },
      display: { default: 'chip' },
    }
  },

  parseHTML() {
    // Attachment DOM is an editor implementation detail. Loading persisted
    // values happens through Markdown plus the separate attachment manifest.
    return [{ tag: 'span[data-composer-attachment]' }]
  },

  renderHTML({ node }) {
    return ['span', {
      'data-composer-attachment': '',
      'data-attachment-id': node.attrs.id,
      contenteditable: 'false',
    }, node.attrs.name]
  },

  renderText({ node }) {
    return `[${node.attrs.name}]`
  },

  renderMarkdown(node) {
    const name = String(node.attrs?.name ?? '').replaceAll('\\', '\\\\').replaceAll(']', '\\]')
    return `[${name}]`
  },

  addNodeView() {
    const registry = this.options.registry
    if (!registry) return null
    const onOpen = this.options.onOpen
    return ({ node, view, getPos }) => {
      const dom = document.createElement('span')
      dom.dataset.composerAttachment = ''
      dom.dataset.attachmentId = String(node.attrs.id)
      dom.contentEditable = 'false'
      dom.setAttribute('role', 'group')

      if (node.attrs.kind === 'image' && node.attrs.display === 'thumbnail') {
        const previewUrl = registry.previewUrl(String(node.attrs.id))
        if (previewUrl) {
          const preview = document.createElement('img')
          preview.className = 'composer-attachment-preview'
          preview.src = previewUrl
          preview.alt = ''
          preview.draggable = false
          dom.append(preview)
        }
      }

      const name = document.createElement('span')
      name.className = 'composer-attachment-name'
      name.textContent = String(node.attrs.name)
      dom.append(name)

      const status = document.createElement('span')
      status.className = 'composer-attachment-status'
      dom.append(status)

      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'composer-attachment-action'
      retry.textContent = 'Retry'
      retry.setAttribute('aria-label', `Retry ${node.attrs.name}`)
      retry.addEventListener('mousedown', (event) => event.preventDefault())
      retry.addEventListener('click', () => registry.retry(String(node.attrs.id)))
      dom.append(retry)

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'composer-attachment-action composer-attachment-remove'
      remove.textContent = 'x'
      remove.setAttribute('aria-label', `Remove ${node.attrs.name}`)
      remove.addEventListener('mousedown', (event) => event.preventDefault())
      remove.addEventListener('click', () => {
        const position = getPos()
        if (typeof position === 'number') view.dispatch(view.state.tr.delete(position, position + node.nodeSize))
      })
      dom.append(remove)

      const open = (event: MouseEvent) => {
        if (!onOpen
          || event.button !== 0
          || (event.target instanceof Element && event.target.closest('button'))) return
        event.preventDefault()
        event.stopPropagation()
        onOpen(String(node.attrs.id), dom)
      }
      dom.addEventListener('mousedown', open)

      const render = () => {
        const state = registry.get(String(node.attrs.id))
        const stateName = state?.status ?? 'idle'
        dom.dataset.uploadState = stateName
        status.textContent = stateName === 'uploading' ? 'Uploading...' : stateName === 'failed' ? 'Failed' : ''
        retry.hidden = stateName !== 'failed'
        dom.setAttribute('aria-label', `${node.attrs.name}, ${stateName}`)
      }
      const unsubscribe = registry.subscribe(render)
      render()
      return {
        dom,
        destroy() {
          dom.removeEventListener('mousedown', open)
          unsubscribe()
        },
      }
    }
  },
})

export function insertAttachment(editor: Editor, attachment: ComposerAttachment): boolean {
  editor.view.dispatch(closeHistory(editor.state.tr))
  const inserted = editor.commands.insertContent({ type: ATTACHMENT_NAME, attrs: attachment })
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr))
  return inserted
}

export function attachmentIds(editor: Editor): Set<string> {
  const ids = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === ATTACHMENT_NAME && typeof node.attrs.id === 'string') ids.add(node.attrs.id)
  })
  return ids
}

// Restore a legacy attachment at its old [filename] marker when possible. A
// draft created before structured documents has no exact node position, so the
// readable marker is the best lossless migration anchor; otherwise append it.
export function restoreAttachment(editor: Editor, attachment: ComposerAttachment): boolean {
  if (attachmentIds(editor).has(attachment.id)) return true
  const marker = `[${attachment.name}]`
  let range: { from: number; to: number } | undefined
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText || !node.text) return
    const offset = node.text.indexOf(marker)
    if (offset >= 0) range = { from: pos + offset, to: pos + offset + marker.length }
  })
  const content = { type: ATTACHMENT_NAME, attrs: attachment }
  if (range) return editor.commands.insertContentAt(range, content)
  return editor.commands.insertContentAt(editor.state.doc.content.size, content)
}
