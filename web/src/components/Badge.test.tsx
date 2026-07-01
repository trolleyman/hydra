import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Badge } from './Badge'
import { TONE_BADGE } from './badgeTones'

describe('Badge', () => {
  it('renders its children', () => {
    const { getByText } = render(<Badge>running</Badge>)
    expect(getByText('running')).toBeInTheDocument()
  })

  it('maps a tone to its TONE_BADGE color classes', () => {
    const { container } = render(<Badge tone="green">ok</Badge>)
    const span = container.querySelector('span')!
    for (const cls of TONE_BADGE.green.split(' ')) expect(span).toHaveClass(cls)
  })

  it('uses an explicit className over a tone (for non-status palettes)', () => {
    const { container } = render(
      <Badge tone="green" className="bg-orange-100 text-orange-800">claude</Badge>,
    )
    const span = container.querySelector('span')!
    expect(span).toHaveClass('bg-orange-100', 'text-orange-800')
    // The tone is overridden, so its color classes must not leak in.
    expect(span).not.toHaveClass('bg-green-100')
  })

  it('stays a plain inline chip when it has no icon', () => {
    const { container } = render(<Badge tone="neutral">pending</Badge>)
    const span = container.querySelector('span')!
    expect(span).not.toHaveClass('inline-flex')
    expect(span.querySelector('svg')).toBeNull()
  })

  it('becomes an inline-flex row that renders the icon when given one', () => {
    const { container } = render(
      <Badge tone="blue" icon={<svg data-testid="icon" />}>building</Badge>,
    )
    const span = container.querySelector('span')!
    expect(span).toHaveClass('inline-flex', 'items-center', 'gap-1')
    expect(span.querySelector('[data-testid="icon"]')).not.toBeNull()
  })

  it('applies the variant sizing/shape presets', () => {
    const sm = render(<Badge>sm</Badge>).container.querySelector('span')!
    expect(sm).toHaveClass('text-xs', 'rounded')
    expect(sm).not.toHaveClass('rounded-full')

    const xs = render(<Badge variant="xs">xs</Badge>).container.querySelector('span')!
    expect(xs).toHaveClass('text-[10px]', 'rounded')

    const pill = render(<Badge variant="pill">pill</Badge>).container.querySelector('span')!
    expect(pill).toHaveClass('rounded-full', 'px-2.5')
  })

  it('passes a title through to the chip', () => {
    const { container } = render(<Badge title="why">x</Badge>)
    expect(container.querySelector('span')).toHaveAttribute('title', 'why')
  })
})
