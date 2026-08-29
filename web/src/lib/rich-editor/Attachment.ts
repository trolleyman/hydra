import { Node, type Editor } from '@tiptap/core'

export const ATTACHMENT_NAME = 'attachment'

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'archive' | 'file'
export type AttachmentDisplay = 'chip' | 'thumbnail' | 'preview'

export interface ComposerAttachment {
  id: string
  name: string
  kind: AttachmentKind
  display: AttachmentDisplay
}

export const Attachment = Node.create({
  name: ATTACHMENT_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

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
})

export function insertAttachment(editor: Editor, attachment: ComposerAttachment): boolean {
  return editor.commands.insertContent({ type: ATTACHMENT_NAME, attrs: attachment })
}

export function attachmentIds(editor: Editor): Set<string> {
  const ids = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === ATTACHMENT_NAME && typeof node.attrs.id === 'string') ids.add(node.attrs.id)
  })
  return ids
}
