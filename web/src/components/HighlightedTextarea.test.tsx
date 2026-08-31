import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HighlightedTextarea } from './HighlightedTextarea'

describe('HighlightedTextarea', () => {
  it('renders a caret-safe visible placeholder in the backdrop', () => {
    const { container } = render(
      <HighlightedTextarea
        value=""
        onChange={() => {}}
        placeholder="Write a message..."
        placeholderClassName="text-stone-400"
      />,
    )

    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveAttribute('placeholder', 'Write a message...')
    expect(textarea).toHaveClass('placeholder:text-transparent')

    const visiblePlaceholder = container.querySelector('[aria-hidden="true"] > span')
    expect(visiblePlaceholder).toHaveTextContent('Write a message...')
    expect(visiblePlaceholder).toHaveClass('pl-0.5', 'text-stone-400')
  })

  it('gives both text layers the same stable scroll column', () => {
    const { container } = render(<HighlightedTextarea value="A wrapping prompt" onChange={() => {}} />)

    const backdrop = container.querySelector<HTMLElement>('[aria-hidden="true"]')
    const textarea = screen.getByRole('textbox')
    expect(backdrop).toHaveClass('highlighted-textarea-backdrop', 'overflow-y-scroll')
    expect(backdrop).toHaveStyle({ scrollbarGutter: 'stable' })
    expect(textarea).toHaveStyle({ scrollbarGutter: 'stable' })
  })
})
