import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownComposer, type MarkdownComposerHandle } from './MarkdownComposer'
import { createRef } from 'react'

afterEach(cleanup)

describe('MarkdownComposer', () => {
  it('exposes Markdown as its controlled value', async () => {
    const changed = vi.fn()
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value="Hello" onChange={changed} />)

    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    const editor = ref.current!.editor!
    editor.chain().setTextSelection(editor.state.doc.content.size).toggleBold().insertContent(' world').run()
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith('Hello **world**'))
    const localChangeCount = changed.mock.calls.length

    view.rerender(<MarkdownComposer ref={ref} value="## External" onChange={changed} />)
    await waitFor(() => expect(ref.current!.editor!.getJSON().content?.[0]).toMatchObject({
      type: 'heading',
      attrs: expect.objectContaining({ level: 2 }),
    }))
    expect(changed).toHaveBeenCalledTimes(localChangeCount)
  })

  it('provides Markdown and selection context to host keyboard handlers', async () => {
    const onKeyDown = vi.fn(() => true)
    const ref = createRef<MarkdownComposerHandle>()
    render(<MarkdownComposer ref={ref} value="draft" onChange={() => {}} onKeyDown={onKeyDown} />)

    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter' }),
      expect.objectContaining({ markdown: 'draft', empty: false }),
    )
  })

  it('restores a structured draft without reparsing its attachment as text', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    render(
      <MarkdownComposer
        ref={ref}
        value="Before [cat.png] after"
        initialDocument={{
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Before ' },
              { type: 'attachment', attrs: { id: 'cat', name: 'cat.png', kind: 'image', display: 'chip' } },
              { type: 'text', text: ' after' },
            ],
          }],
        }}
        onChange={() => {}}
      />,
    )

    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    expect(ref.current!.editor!.getJSON().content?.[0].content?.[1].type).toBe('attachment')
  })

  it('uses only plain text for Ctrl+Shift+V, even when files and HTML are present', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const onPaste = vi.fn(() => true)
    const { getByRole } = render(<MarkdownComposer ref={ref} value="" onChange={() => {}} onPaste={onPaste} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    const textbox = getByRole('textbox')
    fireEvent.keyDown(textbox, { key: 'v', ctrlKey: true, shiftKey: true })
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [new File(['image'], 'image.png', { type: 'image/png' })],
        getData: (type: string) => type === 'text/plain' ? '<b>literal</b>' : '<b>formatted</b>',
        types: ['Files', 'text/html', 'text/plain'],
      },
    })
    expect(ref.current!.editor!.getText()).toBe('<b>literal</b>')
    expect(onPaste).not.toHaveBeenCalled()
  })

  it('keeps supported structure from ordinary HTML paste and drops source styling', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const { getByRole } = render(<MarkdownComposer ref={ref} value="" onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    fireEvent.paste(getByRole('textbox'), {
      clipboardData: {
        files: [],
        getData: (type: string) => type === 'text/html'
          ? '<h2 style="color:red" class="source"><strong>Safe</strong></h2><script>bad()</script>'
          : type === 'text/plain' ? 'Safe' : '',
        types: ['text/html', 'text/plain'],
      },
    })
    const heading = ref.current!.editor!.getJSON().content?.find((node) => node.type === 'heading')
    expect(heading).toMatchObject({
      type: 'heading',
      attrs: expect.objectContaining({ level: 2 }),
      content: [{ type: 'text', text: 'Safe', marks: [{ type: 'bold' }] }],
    })
    expect(ref.current!.editor!.view.dom.innerHTML).not.toMatch(/style=|class="source"|script|bad\(\)/)
  })

  it('turns a URL pasted over selected prose into a link', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const changed = vi.fn()
    const { getByRole } = render(<MarkdownComposer ref={ref} value="label" onChange={changed} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.commands.setTextSelection({ from: 1, to: 6 })
    fireEvent.paste(getByRole('textbox'), {
      clipboardData: {
        files: [],
        getData: (type: string) => type === 'text/plain' ? 'https://example.com/docs' : '',
        types: ['text/plain'],
      },
    })
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith('[label](https://example.com/docs)'))
  })

  it('edits an arbitrary text selection as a link with Ctrl+K', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const changed = vi.fn()
    const view = render(<MarkdownComposer ref={ref} value="Hydra docs" onChange={changed} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.commands.setTextSelection({ from: 1, to: 11 })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'k', ctrlKey: true })
    fireEvent.change(await view.findByRole('textbox', { name: 'Link URL' }), { target: { value: 'docs.example.com/hydra' } })
    fireEvent.click(view.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith('[Hydra docs](https://docs.example.com/hydra)'))
  })

  it('renders the language picker inside a code block and applies highlighting', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={'```\nconst answer = 1\n```'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    fireEvent.click(view.getByRole('button', { name: 'Code block language: Plain text' }))
    fireEvent.change(view.getByRole('combobox', { name: 'Code block language' }), {
      target: { value: 'typescript' },
    })
    fireEvent.click(view.getByRole('option', { name: 'TypeScript' }))
    await waitFor(() => expect(view.container.querySelector('.rich-code-block .token.keyword')).toHaveTextContent('const'))
    expect(ref.current!.editor!.getAttributes('codeBlock').language).toBe('typescript')
  })

  it('canonicalizes a known language label before applying live highlighting', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={"```\nif __name__ == '__main__':\n```"} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    fireEvent.click(view.getByRole('button', { name: 'Code block language: Plain text' }))
    fireEvent.change(view.getByRole('combobox', { name: 'Code block language' }), {
      target: { value: 'Python' },
    })
    fireEvent.click(view.getByRole('button', { name: 'Use "Python"' }))
    await waitFor(() => expect(view.container.querySelector('.rich-code-block .token.keyword')).toHaveTextContent('if'))
    expect(ref.current!.editor!.getAttributes('codeBlock').language).toBe('python')
    expect(ref.current!.editor!.getText()).toContain("if __name__ == '__main__':")
  })

  it('accepts an arbitrary fenced-code language without reserving a toolbar row', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={'```\nvalue\n```'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    fireEvent.click(view.getByRole('button', { name: 'Code block language: Plain text' }))
    const input = view.getByRole('combobox', { name: 'Code block language' })
    fireEvent.change(input, { target: { value: 'cue' } })
    fireEvent.click(view.getByRole('button', { name: 'Use "cue"' }))
    expect(ref.current!.editor!.getAttributes('codeBlock').language).toBe('cue')
    expect(view.container.querySelector('.rich-code-block > select')).toBeNull()
  })

  it('keeps Shift+Enter inside a code block even when the host owns Enter', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const onKeyDown = vi.fn(() => true)
    const view = render(<MarkdownComposer ref={ref} value={'```text\na\n```'} onChange={() => {}} onKeyDown={onKeyDown} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    const editor = ref.current!.editor!
    editor.commands.setTextSelection(2)

    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', shiftKey: true })
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock')
    expect(editor.state.selection.$from.parent.textContent).toBe('a\n')
  })

  it('offers cell-local table actions without a global toolbar', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    expect(view.queryByRole('toolbar', { name: 'Table controls' })).toBeNull()
    const firstCell = view.container.querySelector('th')!
    fireEvent.mouseMove(firstCell)
    fireEvent.click(view.getByRole('button', { name: 'Cell actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Add row below' }))
    expect(ref.current!.editor!.getJSON().content?.[0].content).toHaveLength(3)
    fireEvent.mouseMove(firstCell)
    fireEvent.click(view.getByRole('button', { name: 'Cell actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Add column right' }))
    expect(ref.current!.editor!.getJSON().content?.[0].content?.[0].content).toHaveLength(3)
    fireEvent.mouseMove(firstCell)
    fireEvent.click(view.getByRole('button', { name: 'Cell actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Align center' }))
    expect(ref.current!.editor!.getJSON().content?.[0].content?.map((row) => row.content?.[0].attrs?.align)).toEqual(['center', 'center', 'center'])
  })

  it('grows tables with Tab and Enter while keeping one header row', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    const editor = ref.current!.editor!
    const cells: number[] = []
    editor.state.doc.descendants((node, pos) => { if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') cells.push(pos) })
    editor.commands.setCellSelection({ anchorCell: cells[1] })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Tab' })
    expect(editor.getJSON().content?.[0].content?.[0].content).toHaveLength(3)
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })
    expect(editor.getJSON().content?.[0].content).toHaveLength(3)
    expect(editor.getJSON().content?.[0].content?.[0].content?.every((cell) => cell.type === 'tableHeader')).toBe(true)
    expect(editor.getJSON().content?.[0].content?.slice(1).flatMap((row) => row.content ?? []).every((cell) => cell.type === 'tableCell')).toBe(true)
  })

  it('lets a send-on-Enter host keep Enter and reserves Shift+Enter for table navigation', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const onKeyDown = vi.fn(() => true)
    const view = render(<MarkdownComposer ref={ref} value={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={() => {}} onKeyDown={onKeyDown} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    const editor = ref.current!.editor!
    const cells: number[] = []
    editor.state.doc.descendants((node, pos) => { if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') cells.push(pos) })
    editor.commands.setCellSelection({ anchorCell: cells[0] })

    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', shiftKey: true })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(editor.state.selection.$from.parent.textContent).toBe('1')
  })

  it('lets row and column handle selections be deleted', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={'| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'} onChange={() => {}} />)
    await waitFor(() => expect(view.getByRole('button', { name: 'Select row 2' })).toBeInTheDocument())
    const editor = ref.current!.editor!
    fireEvent.mouseDown(view.getByRole('button', { name: 'Select row 2' }))
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Backspace' })
    expect(editor.getJSON().content?.[0].content).toHaveLength(2)
    fireEvent.mouseDown(view.getByRole('button', { name: 'Select column 2' }))
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Delete' })
    expect(editor.getJSON().content?.[0].content?.[0].content).toHaveLength(1)
  })

  it('discovers slash commands at the start of an empty block', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value="" onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    ref.current!.editor!.commands.insertContent('/co')
    const menu = await view.findByRole('listbox', { name: 'Block commands' })
    expect(menu).toHaveTextContent('Code block')
    fireEvent.click(view.getByRole('option', { name: 'Code block' }))
    expect(ref.current!.editor!.getJSON().content?.[0].type).toBe('codeBlock')
  })

  it('inserts a catalog reference as a structured Markdown node', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const changed = vi.fn()
    const view = render(
      <MarkdownComposer
        ref={ref}
        value=""
        onChange={changed}
        references={[{ kind: 'branch', value: 'hydra/feature' }]}
      />,
    )
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    ref.current!.editor!.commands.insertContent('@branch:feat')
    await view.findByRole('listbox', { name: 'References' })
    fireEvent.click(view.getByRole('option', { name: /hydra\/feature/ }))
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith('[hydra/feature](hydra://branch/hydra/feature)'))
    expect(ref.current!.editor!.getJSON().content?.[0].content?.[0].type).toBe('hydraReference')
  })
  it('leaves IME confirmation keys alone while discovery is open', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const onKeyDown = vi.fn(() => true)
    const view = render(<MarkdownComposer ref={ref} value="" onChange={() => {}} onKeyDown={onKeyDown} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.commands.insertContent('/co')
    await view.findByRole('listbox')
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', isComposing: true })
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(ref.current!.editor!.state.doc.firstChild?.textContent).toBe('/co')
    expect(view.getByRole('listbox')).toBeInTheDocument()
  })

  it('keeps slash and reference examples literal inside code', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value={'```text\n\n```'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.commands.setTextSelection(1)
    ref.current!.editor!.commands.insertContent('/co')
    await waitFor(() => expect(ref.current!.editor!.state.doc.firstChild?.textContent).toBe('/co'))
    expect(view.queryByRole('listbox')).toBeNull()
  })

  it('closes link editing with Escape and returns focus to the document', async () => {
    const ref = createRef<MarkdownComposerHandle>()
    const view = render(<MarkdownComposer ref={ref} value="label" onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.commands.setTextSelection({ from: 1, to: 6 })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'k', ctrlKey: true })
    const input = await view.findByRole('textbox', { name: 'Link URL' })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Link URL' })).toBeNull())
    expect(ref.current!.editor!.getText()).toBe('label')
  })

})
