import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from './SegmentedControl'

describe('SegmentedControl', () => {
  it('exposes one pressed choice and reports a new choice', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        label="Run mode"
        value="terminal"
        options={[{ value: 'terminal', label: 'Terminal' }, { value: 'chat', label: 'Chat' }]}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('group', { name: 'Run mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(onChange).toHaveBeenCalledWith('chat')
  })
})
