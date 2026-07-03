import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { Tooltip } from './Tooltip'
import { InfoTooltip } from './InfoTooltip'

// Component tests for the unified tooltip (PLAN #62). The portal renders into
// document.body, which `screen` queries, so the tooltip box is findable even
// though it's not a DOM child of the trigger. mouseenter/leave don't bubble, so
// events are fired directly on the wrapper <span> that carries the handlers.
afterEach(cleanup)

function wrapper(container: HTMLElement) {
  // The Tooltip root is the <span> holding the hover handlers.
  return container.querySelector('span') as HTMLElement
}

describe('Tooltip - dark variant (default)', () => {
  it('shows only after the hover delay and hides immediately on leave', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content="Refresh" delay={600}>
          <button>trigger</button>
        </Tooltip>,
      )
      const span = wrapper(container)
      expect(screen.queryByText('Refresh')).toBeNull()

      fireEvent.mouseEnter(span)
      // Still hidden one tick before the delay elapses...
      act(() => void vi.advanceTimersByTime(599))
      expect(screen.queryByText('Refresh')).toBeNull()
      // ...and visible once it does.
      act(() => void vi.advanceTimersByTime(1))
      expect(screen.getByText('Refresh')).toBeInTheDocument()

      // Non-interactive: leaving the trigger dismisses it with no grace period.
      fireEvent.mouseLeave(span)
      expect(screen.queryByText('Refresh')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending show when the pointer leaves before the delay', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content="Settings" delay={600}>
          <button>trigger</button>
        </Tooltip>,
      )
      const span = wrapper(container)
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(300))
      fireEvent.mouseLeave(span)
      // The remaining delay elapses but the show timer was cancelled.
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.queryByText('Settings')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not render a box when content is empty', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content="" delay={0}>
          <button>trigger</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(wrapper(container))
      act(() => void vi.advanceTimersByTime(0))
      // No tooltip role/box: the only thing on screen is the trigger button.
      expect(screen.getByText('trigger')).toBeInTheDocument()
      expect(document.body.querySelectorAll('.fixed')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Tooltip - card variant', () => {
  it('shows immediately with title + content and survives the pointer moving into it', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip variant="card" title="OS Sandbox" content={<p>sandbox details</p>}>
          <span>icon</span>
        </Tooltip>,
      )
      const span = wrapper(container)

      // No delay for the card variant.
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(0))
      expect(screen.getByText('OS Sandbox')).toBeInTheDocument()
      expect(screen.getByText('sandbox details')).toBeInTheDocument()

      // Leaving the trigger starts a grace period rather than hiding at once...
      fireEvent.mouseLeave(span)
      // ...and moving onto the card within that window keeps it open.
      const card = screen.getByText('sandbox details').closest('div.fixed') as HTMLElement
      fireEvent.mouseEnter(card)
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.getByText('OS Sandbox')).toBeInTheDocument()

      // Leaving the card itself dismisses it.
      fireEvent.mouseLeave(card)
      expect(screen.queryByText('OS Sandbox')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses after the grace period when the pointer never reaches the card', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip variant="card" content={<p>body</p>}>
          <span>icon</span>
        </Tooltip>,
      )
      const span = wrapper(container)
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(0))
      expect(screen.getByText('body')).toBeInTheDocument()

      fireEvent.mouseLeave(span)
      act(() => void vi.advanceTimersByTime(100))
      expect(screen.queryByText('body')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('InfoTooltip', () => {
  it('renders an info-icon trigger whose hover card holds the body', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <InfoTooltip title="Network Access">
          <p>outbound network details</p>
        </InfoTooltip>,
      )
      // The trigger is the lucide Info svg, hidden until hovered.
      expect(container.querySelector('svg')).toBeTruthy()
      expect(screen.queryByText('Network Access')).toBeNull()

      fireEvent.mouseEnter(wrapper(container))
      act(() => void vi.advanceTimersByTime(0))
      expect(screen.getByText('Network Access')).toBeInTheDocument()
      expect(screen.getByText('outbound network details')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
