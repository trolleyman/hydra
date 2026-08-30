import { CellSelection } from '@tiptap/pm/tables'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRichEditor } from './RichEditorCore'
import { handleTableKeyDown } from './Table'

const editors: ReturnType<typeof createRichEditor>[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function tableEditor(markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |') {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = createRichEditor({ element, markdown })
  editors.push(editor)
  return editor
}

function cellPositions(editor: ReturnType<typeof createRichEditor>): number[] {
  const positions: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') positions.push(pos)
  })
  return positions
}

function key(key: string, options: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key, ...options })
}

describe('table keyboard interaction', () => {
  it('adds a column when Tab leaves the last cell in a row', () => {
    const editor = tableEditor()
    const cells = cellPositions(editor)
    editor.commands.setTextSelection(cells[1] + 2)

    expect(handleTableKeyDown(editor, key('Tab'))).toBe(true)
    expect(editor.getJSON().content?.[0].content?.[0].content).toHaveLength(3)
  })

  it('selects a row with Shift+Right at a cell boundary and deletes it', () => {
    const editor = tableEditor()
    const cells = cellPositions(editor)
    editor.commands.setTextSelection(cells[0] + 2)
    vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(true)

    expect(handleTableKeyDown(editor, key('ArrowRight', { shiftKey: true }))).toBe(true)
    expect(editor.state.selection).toBeInstanceOf(CellSelection)
    expect(handleTableKeyDown(editor, key('Backspace'))).toBe(true)
    expect(editor.getJSON().content?.[0].content).toHaveLength(1)
    expect(editor.getJSON().content?.[0].content?.[0].content?.every((cell) => cell.type === 'tableHeader')).toBe(true)
  })

  it('selects a column with Shift+Down and deletes it', () => {
    const editor = tableEditor()
    const cells = cellPositions(editor)
    editor.commands.setTextSelection(cells[0] + 2)
    vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(true)

    expect(handleTableKeyDown(editor, key('ArrowDown', { shiftKey: true }))).toBe(true)
    expect(editor.state.selection).toBeInstanceOf(CellSelection)
    expect(handleTableKeyDown(editor, key('Delete'))).toBe(true)
    expect(editor.getJSON().content?.[0].content?.every((row) => row.content?.length === 1)).toBe(true)
  })

  it('moves up to the end of the cell above', () => {
    const editor = tableEditor()
    const cells = cellPositions(editor)
    editor.commands.setTextSelection(cells[2] + 2)
    vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(true)

    expect(handleTableKeyDown(editor, key('ArrowUp'))).toBe(true)
    expect(editor.state.selection.$from.parent.textContent).toBe('A')
    expect(editor.state.selection.$from.parentOffset).toBe(1)
  })
})
