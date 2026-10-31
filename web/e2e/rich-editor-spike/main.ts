import { TextSelection } from '@tiptap/pm/state'
import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createRichEditor } from '../../src/lib/rich-editor/RichEditorCore'
import { MarkdownComposer } from '../../src/lib/rich-editor/MarkdownComposer'
import { AttachmentRegistry } from '../../src/lib/rich-editor/AttachmentRegistry'
import '../../src/index.css'

const host = document.querySelector('#editor')
if (!host) throw new Error('Missing editor host')

const initial = {
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [
      { type: 'text', text: 'a ' },
      { type: 'inlineCode', content: [{ type: 'text', text: 'foo' }] },
      { type: 'text', text: ' b' },
    ],
  }],
}

const attachmentRegistry = new AttachmentRegistry(async (_file, id) => ({ path: `/uploads/${id}.png` }))
let openedAttachment = ''
let attachmentCounter = 0
const editor = createRichEditor({
  element: host,
  content: initial,
  attachmentRegistry,
  onOpenAttachment: (id) => { openedAttachment = id },
  attributes: {
    'aria-label': 'Rich editor behavior fixture',
    'data-rich-editor-spike': '',
    spellcheck: 'false',
  },
})

const api = {
  reset(content: Record<string, unknown>) {
    editor.commands.setContent(content)
    editor.view.focus()
  },
  select(from: number, to = from) {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
    editor.view.focus()
  },
  setCodeLanguage(language: string) {
    editor.commands.updateAttributes('codeBlock', { language: language || null })
  },
  addImage() {
    const id = `image-${++attachmentCounter}`
    attachmentRegistry.add(editor, {
      id,
      name: `${id}.png`,
      kind: 'image',
      display: 'thumbnail',
    }, new File(['image'], `${id}.png`, { type: 'image/png' }), 'data:image/png;base64,iVBORw0KGgo=')
    return id
  },
  openedAttachment: () => openedAttachment,
  snapshot() {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
    return {
      doc: editor.getJSON(),
      text: editor.getText(),
      from: editor.state.selection.from,
      to: editor.state.selection.to,
      parent: editor.state.selection.$from.parent.type.name,
      domInsideCode: Boolean(anchorElement?.closest('code[data-inline-code]')),
      activeCode: document.querySelectorAll('code[data-inline-code-active]').length,
    }
  },
}

declare global {
  interface Window {
    richEditorSpike: typeof api
  }
}

window.richEditorSpike = api

const interactiveHost = document.querySelector('#interactive-editor')
if (!interactiveHost) throw new Error('Missing interactive editor host')
function InteractiveFixture() {
  const [value, setValue] = useState('| A | B |\n| --- | --- |\n| 1 | 2 |')
  const [interactiveEditor, setInteractiveEditor] = useState<ReturnType<typeof createRichEditor> | null>(null)
  useEffect(() => {
    window.interactiveRichEditor = interactiveEditor
    return () => {
      if (window.interactiveRichEditor === interactiveEditor) window.interactiveRichEditor = null
    }
  }, [interactiveEditor])
  return createElement(MarkdownComposer, {
    value,
    onChange: setValue,
    // Reproduce chat's send-on-Enter host contract. The composer itself must
    // still retain Shift+Enter when the selection is inside fenced code.
    onKeyDown: (event) => event.key === 'Enter',
    references: [
      { kind: 'branch', value: 'hydra/rich-text' },
      { kind: 'agent', value: 'reviewer' },
    ],
    ariaLabel: 'Interactive rich editor fixture',
    className: 'fixture-interactive-editor',
    onEditor: setInteractiveEditor,
  })
}

createRoot(interactiveHost).render(createElement(InteractiveFixture))

declare global {
  interface Window {
    interactiveRichEditor: ReturnType<typeof createRichEditor> | null
  }
}
