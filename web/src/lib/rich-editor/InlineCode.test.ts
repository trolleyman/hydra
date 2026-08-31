import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import { inlineCodeCommands } from './InlineCode'
import { createInlineCodeSpike } from './spikeEditor'

const editors: Editor[] = []

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

function make(content: Record<string, unknown>): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = createInlineCodeSpike({ element, content })
  editors.push(editor)
  return editor
}

function paragraph(...content: Record<string, unknown>[]) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', ...(content.length > 0 ? { content } : {}) }],
  }
}

function code(text = ''): Record<string, unknown> {
  return text ? { type: 'inlineCode', content: [{ type: 'text', text }] } : { type: 'inlineCode' }
}

function text(value: string): Record<string, unknown> {
  return { type: 'text', text: value }
}

function select(editor: Editor, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

describe('inline-code logical positions', () => {
  // In this document the code node is [3, 8], with its editable content [4, 7].
  const mixed = () => make(paragraph(text('a '), code('foo'), text(' b')))

  it('enters and exits each edge as a distinct arrow step', () => {
    const editor = mixed()
    select(editor, 3)
    expect(inlineCodeCommands.arrowRight(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(4)

    expect(inlineCodeCommands.arrowLeft(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(3)

    select(editor, 8)
    expect(inlineCodeCommands.arrowLeft(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(7)

    expect(inlineCodeCommands.arrowRight(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(8)
  })

  it('moves through interior graphemes explicitly', () => {
    const editor = mixed()
    select(editor, 5)
    expect(inlineCodeCommands.arrowLeft(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(4)
    expect(inlineCodeCommands.arrowRight(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(5)
  })

  it('uses Home and End to leave the whole inline-code node', () => {
    const editor = mixed()
    select(editor, 5)
    expect(inlineCodeCommands.home(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(3)
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')

    select(editor, 5)
    expect(inlineCodeCommands.end(editor)).toBe(true)
    expect(editor.state.selection.from).toBe(8)
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
  })
})

describe('inline-code insertion and exit', () => {
  it('inserts an empty editable node and puts the caret inside it', () => {
    const editor = make(paragraph())
    select(editor, 1)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph(code()))
    expect(editor.state.selection.from).toBe(2)
    expect(editor.state.selection.$from.parent.type.name).toBe('inlineCode')
  })

  it('wraps and keeps a one-line selection selected', () => {
    const editor = make(paragraph(text('abc')))
    select(editor, 1, 4)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph(code('abc')))
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([2, 5])
  })

  it('uses a typed backtick inside code as an exit command', () => {
    const editor = make(paragraph(code('foo')))
    select(editor, 3)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph(code('foo')))
    expect(editor.state.selection.from).toBe(6)
  })

  it('treats a backtick at the mapped outside-after edge as the same exit', () => {
    const editor = make(paragraph(code('foo')))
    select(editor, 6)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph(code('foo')))
    expect(editor.state.selection.from).toBe(6)
  })

  it('upgrades three backticks in an empty paragraph to a code block', () => {
    const editor = make(paragraph())
    select(editor, 1)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(inlineCodeCommands.backtick(editor)).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: null } }],
    })
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock')
  })
})

describe('inline-code deletion', () => {
  it('removes an empty node from either inside boundary', () => {
    const editor = make(paragraph(code()))
    select(editor, 2)
    expect(inlineCodeCommands.backspace(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph())
    expect(editor.state.selection.from).toBe(1)

    editor.commands.setContent(paragraph(code()))
    select(editor, 2)
    expect(inlineCodeCommands.deleteForward(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph())
    expect(editor.state.selection.from).toBe(1)
  })

  it('unwraps from all four non-empty boundaries without deleting text', () => {
    const cases: [number, (editor: Editor) => boolean, number][] = [
      [4, inlineCodeCommands.backspace, 3],
      [7, inlineCodeCommands.deleteForward, 6],
      [8, inlineCodeCommands.backspace, 6],
      [3, inlineCodeCommands.deleteForward, 3],
    ]
    for (const [position, command, expectedCaret] of cases) {
      const editor = make(paragraph(text('a '), code('foo'), text(' b')))
      select(editor, position)
      expect(command(editor)).toBe(true)
      expect(editor.getText()).toBe('a foo b')
      expect(editor.getJSON()).toEqual(paragraph(text('a foo b')))
      expect(editor.state.selection.from).toBe(expectedCaret)
      editor.destroy()
      editors.splice(editors.indexOf(editor), 1)
    }
  })

  it('leaves partial selections alone and deletes interior graphemes explicitly', () => {
    const editor = make(paragraph(code('foo')))
    select(editor, 3, 4)
    expect(inlineCodeCommands.backspace(editor)).toBe(false)
    expect(inlineCodeCommands.deleteForward(editor)).toBe(false)
    select(editor, 4)
    expect(inlineCodeCommands.backspace(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph(code('fo')))
    expect(editor.state.selection.from).toBe(3)
    expect(inlineCodeCommands.deleteForward(editor)).toBe(true)
    expect(editor.getJSON()).toEqual(paragraph(code('f')))
    expect(editor.state.selection.from).toBe(3)
  })
})
