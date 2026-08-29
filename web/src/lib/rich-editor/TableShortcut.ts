import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'

export const TableShortcut = Extension.create({
  name: 'tableShortcut',
  priority: 1_000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          const { $from } = state.selection
          if (!state.selection.empty
            || $from.parent.type.name !== 'paragraph'
            || $from.parentOffset !== 2
            || $from.parent.textContent !== '| ') return null
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
        },
      }),
    ]
  },
})
