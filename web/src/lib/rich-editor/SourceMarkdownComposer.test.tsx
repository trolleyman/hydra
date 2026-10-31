import { fireEvent, render } from '@testing-library/react'
import { createRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceMarkdownComposer } from './SourceMarkdownComposer'
import type { MarkdownComposerHandle } from './MarkdownComposer'

it('keeps source delimiters literal and exposes native focus to note hosts', () => {
  const ref = createRef<MarkdownComposerHandle>()
  function Note() {
    const [value, setValue] = useState('**draft** with `code`')
    return <SourceMarkdownComposer ref={ref} value={value} onChange={setValue} ariaLabel="Note" />
  }
  const view = render(<Note />)
  const textarea = view.getByRole('textbox') as HTMLTextAreaElement
  expect(textarea).toHaveValue('**draft** with `code`')
  ref.current!.focus('start')
  expect(textarea).toHaveFocus()
  expect(textarea.selectionStart).toBe(0)
  fireEvent.change(textarea, { target: { value: '*changed*' } })
  expect(textarea).toHaveValue('*changed*')
  expect(ref.current!.editor).toBeNull()
})

describe('source note keyboard contracts', () => {
  it('lets a host consume Enter without inserting a newline', () => {
    const onKeyDown = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return true })
    const view = render(<SourceMarkdownComposer value="reply" onChange={() => {}} onKeyDown={onKeyDown} />)
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', ctrlKey: true })
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }), expect.objectContaining({ markdown: 'reply', editor: null }))
    expect(view.getByRole('textbox')).toHaveValue('reply')
  })
})
