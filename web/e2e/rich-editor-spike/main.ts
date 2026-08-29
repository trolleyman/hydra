import { TextSelection } from '@tiptap/pm/state'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createRichEditor } from '../../src/lib/rich-editor/RichEditorCore'
import { RichComposer } from '../../src/lib/rich-editor/RichComposer'
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

const editor = createRichEditor({
  element: host,
  content: initial,
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
createRoot(interactiveHost).render(createElement(RichComposer, {
  value: '| A | B |\n| --- | --- |\n| 1 | 2 |',
  onChange: () => {},
  ariaLabel: 'Interactive rich editor fixture',
  className: 'fixture-interactive-editor',
}))
