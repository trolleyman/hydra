import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('renders its icon child inside a button', () => {
    const { getByRole } = render(
      <IconButton aria-label="close"><svg data-testid="x" /></IconButton>,
    )
    const btn = getByRole('button', { name: 'close' })
    expect(btn.querySelector('[data-testid="x"]')).not.toBeNull()
  })

  it('defaults to type="button" so it never submits a form', () => {
    const { getByRole } = render(<IconButton aria-label="a"><svg /></IconButton>)
    expect(getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('forwards onClick', () => {
    const onClick = vi.fn()
    const { getByRole } = render(<IconButton aria-label="go" onClick={onClick}><svg /></IconButton>)
    fireEvent.click(getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('forwards native props (disabled, title) and skips click when disabled', () => {
    const onClick = vi.fn()
    const { getByRole } = render(
      <IconButton aria-label="d" title="tip" disabled onClick={onClick}><svg /></IconButton>,
    )
    const btn = getByRole('button')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'tip')
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('applies the ghost variant by default', () => {
    const { getByRole } = render(<IconButton aria-label="g"><svg /></IconButton>)
    const btn = getByRole('button')
    expect(btn).toHaveClass('rounded-md', 'p-1', 'text-gray-400')
    expect(btn).not.toHaveClass('w-9')
  })

  it('applies the panel variant when requested', () => {
    const { getByRole } = render(<IconButton variant="panel" aria-label="p"><svg /></IconButton>)
    const btn = getByRole('button')
    expect(btn).toHaveClass('w-9', 'h-9', 'flex', 'rounded-lg')
  })

  it('appends caller className alongside the variant classes', () => {
    const { getByRole } = render(
      <IconButton variant="panel" aria-label="c" className="shrink-0 -ml-1"><svg /></IconButton>,
    )
    const btn = getByRole('button')
    expect(btn).toHaveClass('shrink-0', '-ml-1', 'w-9')
  })
})
