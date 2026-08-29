import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichComposer, type RichComposerHandle } from './RichComposer'
import { createRef } from 'react'

afterEach(cleanup)

describe('RichComposer', () => {
  it('exposes Markdown as its controlled value', async () => {
    const changed = vi.fn()
    const ref = createRef<RichComposerHandle>()
    const view = render(<RichComposer ref={ref} value="Hello" onChange={changed} />)

    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    const editor = ref.current!.editor!
    editor.chain().setTextSelection(editor.state.doc.content.size).toggleBold().insertContent(' world').run()
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith('Hello **world**'))
    const localChangeCount = changed.mock.calls.length

    view.rerender(<RichComposer ref={ref} value="## External" onChange={changed} />)
    await waitFor(() => expect(ref.current!.editor!.getJSON().content?.[0]).toMatchObject({
      type: 'heading',
      attrs: expect.objectContaining({ level: 2 }),
    }))
    expect(changed).toHaveBeenCalledTimes(localChangeCount)
  })

  it('keeps Tiptap out of the keyboard callback context value', async () => {
    const onKeyDown = vi.fn(() => true)
    const ref = createRef<RichComposerHandle>()
    render(<RichComposer ref={ref} value="draft" onChange={() => {}} onKeyDown={onKeyDown} />)

    await waitFor(() => expect(ref.current?.editor).not.toBeNull())
    ref.current!.editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter' }),
      expect.objectContaining({ markdown: 'draft', empty: false }),
    )
  })

  it('restores a structured draft without reparsing its attachment as text', async () => {
    const ref = createRef<RichComposerHandle>()
    render(
      <RichComposer
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
    const ref = createRef<RichComposerHandle>()
    const onPaste = vi.fn(() => true)
    const { getByRole } = render(<RichComposer ref={ref} value="" onChange={() => {}} onPaste={onPaste} />)
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
    const ref = createRef<RichComposerHandle>()
    const { getByRole } = render(<RichComposer ref={ref} value="" onChange={() => {}} />)
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
    const ref = createRef<RichComposerHandle>()
    const changed = vi.fn()
    const { getByRole } = render(<RichComposer ref={ref} value="label" onChange={changed} />)
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

  it('renders the language picker inside a code block and applies highlighting', async () => {
    const ref = createRef<RichComposerHandle>()
    const view = render(<RichComposer ref={ref} value={'```\nconst answer = 1\n```'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    fireEvent.change(view.getByRole('combobox', { name: 'Code block language' }), {
      target: { value: 'typescript' },
    })
    await waitFor(() => expect(view.container.querySelector('.rich-code-block .token.keyword')).toHaveTextContent('const'))
    expect(ref.current!.editor!.getAttributes('codeBlock').language).toBe('typescript')
  })

  it('shows accessible controls on a focused table and reshapes it', async () => {
    const ref = createRef<RichComposerHandle>()
    const view = render(<RichComposer ref={ref} value={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={() => {}} />)
    await waitFor(() => expect(ref.current?.editor).not.toBeNull())

    ref.current!.editor!.commands.setTextSelection(3)
    const toolbar = view.getByRole('toolbar', { name: 'Table controls' })
    expect(toolbar).toBeInTheDocument()
    fireEvent.click(view.getByRole('button', { name: 'Add row below' }))
    expect(ref.current!.editor!.getJSON().content?.[0].content).toHaveLength(3)
    fireEvent.click(view.getByRole('button', { name: 'Add column after' }))
    expect(ref.current!.editor!.getJSON().content?.[0].content?.[0].content).toHaveLength(3)
    fireEvent.click(view.getByRole('button', { name: 'Delete table' }))
    expect(ref.current!.editor!.getJSON().content?.some((node) => node.type === 'table')).toBe(false)
  })
})
