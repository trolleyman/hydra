import { Editor, Node } from '@tiptap/core'
import { InlineCode, InlineCodeEditing } from './InlineCode'

const Document = Node.create({
  name: 'doc',
  topNode: true,
  content: 'paragraph+',
})

const Paragraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})

const Text = Node.create({ name: 'text', group: 'inline' })

export interface InlineCodeSpikeOptions {
  element: Element
  content?: string | Record<string, unknown>
}

export function createInlineCodeSpike(options: InlineCodeSpikeOptions): Editor {
  return new Editor({
    element: options.element,
    extensions: [Document, Paragraph, Text, InlineCode, InlineCodeEditing],
    content: options.content ?? '<p></p>',
    injectCSS: false,
    autofocus: false,
    editorProps: {
      attributes: {
        'aria-label': 'Inline code behavior spike',
        'data-rich-editor-spike': '',
        spellcheck: 'false',
      },
    },
  })
}
