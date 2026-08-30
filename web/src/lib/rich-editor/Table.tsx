import { Editor, Extension } from '@tiptap/core'
import { Table, type TableOptions } from '@tiptap/extension-table'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { CellSelection, TableMap, selectionCell } from '@tiptap/pm/tables'

interface InteractiveTableOptions extends TableOptions {
  controls: boolean
}

interface CellContext {
  table: ProseMirrorNode
  tableStart: number
  map: TableMap
  cellPos: number
  row: number
  col: number
}

function cellContext(state: EditorState): CellContext | null {
  let $cell
  try {
    $cell = state.selection instanceof CellSelection ? state.selection.$headCell : selectionCell(state)
  } catch {
    return null
  }
  if (!$cell) return null
  const table = $cell.node(-1)
  if (table.type.spec.tableRole !== 'table') return null
  const tableStart = $cell.start(-1)
  const map = TableMap.get(table)
  const cellPos = $cell.pos
  const rect = map.findCell(cellPos - tableStart)
  return { table, tableStart, map, cellPos, row: rect.top, col: rect.left }
}

function cellPosition(context: CellContext, row: number, col: number): number {
  return context.tableStart + context.map.positionAt(row, col, context.table)
}

function moveCaretToCell(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, row: number, col: number, end = false): boolean {
  const context = cellContext(state)
  if (!context || row < 0 || row >= context.map.height || col < 0 || col >= context.map.width) return false
  const pos = cellPosition(context, row, col)
  const cell = state.doc.nodeAt(pos)
  if (!cell) return false
  const target = end ? pos + cell.nodeSize - 1 : pos + 1
  dispatch?.(state.tr.setSelection(TextSelection.near(state.doc.resolve(target), end ? -1 : 1)).scrollIntoView())
  return true
}

function selectCells(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, anchorRow: number, anchorCol: number, headRow: number, headCol: number): boolean {
  const context = cellContext(state)
  if (!context) return false
  const anchor = cellPosition(context, anchorRow, anchorCol)
  const head = cellPosition(context, headRow, headCol)
  dispatch?.(state.tr.setSelection(new CellSelection(state.doc.resolve(anchor), state.doc.resolve(head))).scrollIntoView())
  return true
}

function selectedRectangle(state: EditorState) {
  if (!(state.selection instanceof CellSelection)) return null
  const context = cellContext(state)
  if (!context) return null
  return {
    context,
    rect: context.map.rectBetween(
      state.selection.$anchorCell.pos - context.tableStart,
      state.selection.$headCell.pos - context.tableStart,
    ),
  }
}

export function isTableSelection(editor: Editor): boolean {
  return cellContext(editor.state) !== null
}

export function handleTableKeyDown(editor: Editor, event: KeyboardEvent): boolean {
  const context = cellContext(editor.state)
  if (!context) return false

  if ((event.key === 'Backspace' || event.key === 'Delete') && editor.state.selection instanceof CellSelection) {
    const selected = selectedRectangle(editor.state)
    if (!selected) return false
    const wholeRows = selected.rect.left === 0 && selected.rect.right === selected.context.map.width
    const wholeColumns = selected.rect.top === 0 && selected.rect.bottom === selected.context.map.height
    if (!wholeRows && !wholeColumns) return false
    event.preventDefault()
    if (wholeRows && wholeColumns) return editor.commands.deleteTable()
    if (wholeRows) return editor.commands.deleteRow()
    return editor.commands.deleteColumn()
  }

  if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    if (event.shiftKey) {
      return context.col > 0 && moveCaretToCell(editor.state, editor.view.dispatch, context.row, context.col - 1)
    }
    if (context.col === context.map.width - 1) editor.commands.addColumnAfter()
    return moveCaretToCell(editor.state, editor.view.dispatch, context.row, context.col + 1)
  }

  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    if (context.row === context.map.height - 1) editor.commands.addRowAfter()
    return moveCaretToCell(editor.state, editor.view.dispatch, context.row + 1, 0)
  }

  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
  const direction = arrows[event.key as keyof typeof arrows]
  if (!direction || (!(editor.state.selection instanceof CellSelection) && !editor.view.endOfTextblock(direction))) return false
  const vertical = direction === 'up' || direction === 'down'
  const delta = direction === 'left' || direction === 'up' ? -1 : 1
  const row = context.row + (vertical ? delta : 0)
  const col = context.col + (vertical ? 0 : delta)
  if (row < 0 || row >= context.map.height || col < 0 || col >= context.map.width) return false
  event.preventDefault()
  if (event.shiftKey) {
    const selection = editor.state.selection
    const anchor = selection instanceof CellSelection
      ? context.map.findCell(selection.$anchorCell.pos - context.tableStart)
      : { top: context.row, left: context.col }
    return selectCells(editor.state, editor.view.dispatch, anchor.top, anchor.left, row, col)
  }
  return moveCaretToCell(editor.state, editor.view.dispatch, row, col, direction === 'left' || direction === 'up')
}

function normalizeHeaderRows(state: EditorState): Transaction | null {
  let tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole !== 'table') return true
    node.forEach((row, rowOffset, rowIndex) => {
      row.forEach((cell, cellOffset) => {
        const wanted = rowIndex === 0 ? state.schema.nodes.tableHeader : state.schema.nodes.tableCell
        if (wanted && cell.type !== wanted) {
          tr = tr.setNodeMarkup(pos + 2 + rowOffset + cellOffset, wanted, cell.attrs, cell.marks)
          changed = true
        }
      })
    })
    return false
  })
  return changed ? tr : null
}

export const TableInteraction = Extension.create({
  name: 'tableInteraction',
  priority: 1_100,

  addKeyboardShortcuts() {
    const run = (key: string, shiftKey = false) => handleTableKeyDown(this.editor, new KeyboardEvent('keydown', { key, shiftKey }))
    return {
      Tab: () => run('Tab'),
      'Shift-Tab': () => run('Tab', true),
      Enter: () => run('Enter'),
      'Shift-Enter': () => run('Enter', true),
      Backspace: () => run('Backspace'),
      Delete: () => run('Delete'),
      ArrowLeft: () => run('ArrowLeft'),
      ArrowRight: () => run('ArrowRight'),
      ArrowUp: () => run('ArrowUp'),
      ArrowDown: () => run('ArrowDown'),
      'Shift-ArrowLeft': () => run('ArrowLeft', true),
      'Shift-ArrowRight': () => run('ArrowRight', true),
      'Shift-ArrowUp': () => run('ArrowUp', true),
      'Shift-ArrowDown': () => run('ArrowDown', true),
    }
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction: (transactions, _old, state) => transactions.some((tr) => tr.docChanged) ? normalizeHeaderRows(state) : null,
    })]
  },
})

function announce(view: { dom: HTMLElement }, message: string) {
  view.dom.dispatchEvent(new CustomEvent('rich-table-announcement', { bubbles: true, detail: message }))
}

export const InteractiveTable = Table.extend<InteractiveTableOptions>({
  addOptions() {
    return { ...(this.parent?.() as TableOptions), controls: false }
  },

  addNodeView() {
    if (!this.options.controls) return null
    return ({ editor, view, HTMLAttributes }) => {
      const dom = document.createElement('div')
      dom.className = 'tableWrapper rich-table-wrapper'

      const columnHandles = document.createElement('div')
      columnHandles.className = 'rich-table-column-handles'
      columnHandles.contentEditable = 'false'
      const rowHandles = document.createElement('div')
      rowHandles.className = 'rich-table-row-handles'
      rowHandles.contentEditable = 'false'

      const cellMenuButton = document.createElement('button')
      cellMenuButton.type = 'button'
      cellMenuButton.className = 'rich-table-cell-menu-trigger'
      cellMenuButton.contentEditable = 'false'
      cellMenuButton.setAttribute('aria-label', 'Cell actions')
      cellMenuButton.textContent = '...'

      const cellMenu = document.createElement('div')
      cellMenu.className = 'rich-table-cell-menu'
      cellMenu.contentEditable = 'false'
      cellMenu.setAttribute('role', 'menu')
      let activeCell: HTMLTableCellElement | null = null

      const contentDOM = document.createElement('table')
      for (const [name, value] of Object.entries(HTMLAttributes)) {
        if (value !== null && value !== undefined) contentDOM.setAttribute(name, String(value))
      }

      const activePosition = () => activeCell ? view.posAtDOM(activeCell, 0) - 1 : null
      const focusCell = () => {
        const pos = activePosition()
        return pos != null && editor.commands.setCellSelection({ anchorCell: pos })
      }
      const restoreCaret = () => {
        const pos = activePosition()
        if (pos == null || pos < 0 || !editor.state.doc.nodeAt(pos)) return
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1), 1)))
      }
      const action = (label: string, run: () => boolean, confirmation: string, disabled = false) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.textContent = label
        button.disabled = disabled
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', () => {
          if (!focusCell()) return
          if (run()) announce(view, confirmation)
          restoreCaret()
          cellMenu.dataset.open = 'false'
        })
        cellMenu.append(button)
      }
      const rebuildMenu = () => {
        cellMenu.replaceChildren()
        const row = (activeCell?.parentElement as HTMLTableRowElement | null)?.rowIndex ?? 0
        action('Add row above', () => editor.commands.addRowBefore(), 'Row added above', row === 0)
        action('Add row below', () => editor.commands.addRowAfter(), 'Row added below')
        action('Add column left', () => editor.commands.addColumnBefore(), 'Column added to the left')
        action('Add column right', () => editor.commands.addColumnAfter(), 'Column added to the right')
        const separator = document.createElement('div')
        separator.className = 'rich-table-cell-menu-separator'
        cellMenu.append(separator)
        for (const [label, align] of [['Align left', 'left'], ['Align center', 'center'], ['Align right', 'right']] as const) {
          action(label, () => {
            const pos = activePosition()
            if (pos == null) return false
            const $cell = editor.state.doc.resolve(pos)
            const tableStart = $cell.start(-1)
            const table = $cell.node(-1)
            const map = TableMap.get(table)
            const rect = map.findCell(pos - tableStart)
            editor.commands.setCellSelection({
              anchorCell: tableStart + map.positionAt(0, rect.left, table),
              headCell: tableStart + map.positionAt(map.height - 1, rect.left, table),
            })
            return editor.commands.setCellAttribute('align', align)
          }, `${label} for column`)
        }
      }

      cellMenuButton.addEventListener('mousedown', (event) => event.preventDefault())
      cellMenuButton.addEventListener('click', () => {
        rebuildMenu()
        cellMenu.dataset.open = cellMenu.dataset.open === 'true' ? 'false' : 'true'
      })

      let drag: { axis: 'row' | 'column'; anchor: number } | null = null
      const stopDrag = () => { drag = null }
      const closeMenu = (event: MouseEvent) => {
        if (event.target instanceof Node && !cellMenu.contains(event.target) && event.target !== cellMenuButton) cellMenu.dataset.open = 'false'
      }
      document.addEventListener('mouseup', stopDrag)
      document.addEventListener('mousedown', closeMenu)

      const selectColumn = (anchor: number, head: number) => {
        const first = contentDOM.rows[0]?.cells[anchor]
        const last = contentDOM.rows[contentDOM.rows.length - 1]?.cells[head]
        if (!first || !last) return
        editor.commands.setCellSelection({ anchorCell: view.posAtDOM(first, 0) - 1, headCell: view.posAtDOM(last, 0) - 1 })
      }
      const selectRow = (anchor: number, head: number) => {
        const first = contentDOM.rows[anchor]?.cells[0]
        const lastRow = contentDOM.rows[head]
        const last = lastRow?.cells[lastRow.cells.length - 1]
        if (!first || !last) return
        editor.commands.setCellSelection({ anchorCell: view.posAtDOM(first, 0) - 1, headCell: view.posAtDOM(last, 0) - 1 })
      }

      const rebuildHandles = () => {
        columnHandles.replaceChildren()
        rowHandles.replaceChildren()
        const wrapperRect = dom.getBoundingClientRect()
        const firstRow = contentDOM.rows[0]
        if (firstRow) [...firstRow.cells].forEach((cell, index) => {
          const rect = cell.getBoundingClientRect()
          const button = document.createElement('button')
          button.type = 'button'
          button.setAttribute('aria-label', `Select column ${index + 1}`)
          button.style.left = `${rect.left - wrapperRect.left}px`
          button.style.width = `${rect.width}px`
          button.addEventListener('mousedown', (event) => { event.preventDefault(); drag = { axis: 'column', anchor: index }; selectColumn(index, index) })
          button.addEventListener('mouseenter', () => { if (drag?.axis === 'column') selectColumn(drag.anchor, index) })
          columnHandles.append(button)
        })
        ;[...contentDOM.rows].forEach((row, index) => {
          const rect = row.getBoundingClientRect()
          const button = document.createElement('button')
          button.type = 'button'
          button.setAttribute('aria-label', `Select row ${index + 1}`)
          button.style.top = `${rect.top - wrapperRect.top}px`
          button.style.height = `${rect.height}px`
          button.addEventListener('mousedown', (event) => { event.preventDefault(); drag = { axis: 'row', anchor: index }; selectRow(index, index) })
          button.addEventListener('mouseenter', () => { if (drag?.axis === 'row') selectRow(drag.anchor, index) })
          rowHandles.append(button)
        })
      }

      const positionCellMenu = (cell: HTMLTableCellElement) => {
        activeCell = cell
        const wrapper = dom.getBoundingClientRect()
        const rect = cell.getBoundingClientRect()
        cellMenuButton.style.top = `${rect.top - wrapper.top + 3}px`
        cellMenuButton.style.left = `${rect.right - wrapper.left - 24}px`
        cellMenu.style.top = `${rect.top - wrapper.top + 26}px`
        cellMenu.style.left = `${Math.max(4, Math.min(rect.right - wrapper.left - 176, dom.clientWidth - 180))}px`
      }
      contentDOM.addEventListener('mousemove', (event) => {
        const cell = (event.target as Element).closest('th, td') as HTMLTableCellElement | null
        if (cell) positionCellMenu(cell)
      })
      contentDOM.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (!hit) return
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos), 1)))
      })
      dom.addEventListener('mouseleave', () => { if (cellMenu.dataset.open !== 'true') activeCell = null })

      const observer = new MutationObserver(() => queueMicrotask(rebuildHandles))
      observer.observe(contentDOM, { childList: true, subtree: true })
      const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(rebuildHandles)
      resize?.observe(contentDOM)
      queueMicrotask(rebuildHandles)

      dom.append(columnHandles, rowHandles, cellMenuButton, cellMenu, contentDOM)
      return {
        dom,
        contentDOM,
        ignoreMutation(mutation) {
          if (mutation.type === 'selection') return false
          return !contentDOM.contains(mutation.target)
        },
        destroy() {
          observer.disconnect()
          resize?.disconnect()
          document.removeEventListener('mouseup', stopDrag)
          document.removeEventListener('mousedown', closeMenu)
        },
      }
    }
  },
})
