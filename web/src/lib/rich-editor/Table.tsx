import { Table, type TableOptions } from '@tiptap/extension-table'

interface InteractiveTableOptions extends TableOptions {
  controls: boolean
}

export const InteractiveTable = Table.extend<InteractiveTableOptions>({
  addOptions() {
    return {
      ...(this.parent?.() as TableOptions),
      controls: false,
    }
  },

  addNodeView() {
    if (!this.options.controls) return null
    return ({ editor, view, HTMLAttributes }) => {
      const dom = document.createElement('div')
      dom.className = 'tableWrapper rich-table-wrapper'

      const controls = document.createElement('div')
      controls.className = 'rich-table-controls'
      controls.contentEditable = 'false'
      controls.setAttribute('role', 'toolbar')
      controls.setAttribute('aria-label', 'Table controls')

      const action = (label: string, text: string, confirmation: string, run: () => boolean) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('aria-label', label)
        button.textContent = text
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', () => {
          editor.commands.focus()
          if (run()) {
            view.dom.dispatchEvent(new CustomEvent('rich-table-announcement', {
              bubbles: true,
              detail: confirmation,
            }))
          }
        })
        controls.append(button)
      }
      action('Add row below', 'Row +', 'Row added', () => editor.commands.addRowAfter())
      action('Delete row', 'Row -', 'Row deleted', () => editor.commands.deleteRow())
      action('Add column after', 'Column +', 'Column added', () => editor.commands.addColumnAfter())
      action('Delete column', 'Column -', 'Column deleted', () => editor.commands.deleteColumn())
      action('Delete table', 'Delete', 'Table deleted', () => editor.commands.deleteTable())

      const contentDOM = document.createElement('table')
      for (const [name, value] of Object.entries(HTMLAttributes)) {
        if (value !== null && value !== undefined) contentDOM.setAttribute(name, String(value))
      }
      dom.append(controls, contentDOM)
      return { dom, contentDOM }
    }
  },
})
