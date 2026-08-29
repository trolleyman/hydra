import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'

function replaceParagraphWithTable(state: EditorState, includeSpace: boolean): Transaction | null {
  const { $from } = state.selection
  const expected = includeSpace ? '| ' : '|'
  if (!state.selection.empty
    || $from.parent.type.name !== 'paragraph'
    || $from.parentOffset !== expected.length
    || $from.parent.textContent !== expected) return null
  const { table, tableRow, tableHeader, tableCell, paragraph } = state.schema.nodes
  if (!table || !tableRow || !tableHeader || !tableCell || !paragraph) return null
  const empty = () => paragraph.create()
  const header = () => tableHeader.create(null, empty())
  const cell = () => tableCell.create(null, empty())
  const node = table.create(null, [
    tableRow.create(null, [header(), header()]),
    tableRow.create(null, [cell(), cell()]),
  ])
  const depth = $from.depth
  const from = $from.before(depth)
  const tr = state.tr.replaceWith(from, $from.after(depth), node)
  return tr.setSelection(TextSelection.near(tr.doc.resolve(from + 3)))
}

export const TableShortcut = Extension.create({
  name: 'tableShortcut',
  priority: 1_000,

  addKeyboardShortcuts() {
    return {
      Space: () => this.editor.commands.command(({ state, dispatch }) => {
        const tr = replaceParagraphWithTable(state, false)
        if (!tr) return false
        dispatch?.(tr)
        return true
      }),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          return replaceParagraphWithTable(state, true)
        },
      }),
    ]
  },
})
