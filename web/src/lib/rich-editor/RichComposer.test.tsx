import { cleanup, render, waitFor } from '@testing-library/react'
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
    expect(changed).toHaveBeenLastCalledWith('Hello **world**')
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
})
