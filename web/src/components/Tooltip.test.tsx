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

describe('Tooltip', () => {
  it('shows only after the hover delay and hides after the pointer grace period', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content="Refresh">
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

      // Leaving gives the pointer time to enter the selectable tooltip.
      fireEvent.mouseLeave(span)
      expect(screen.getByText('Refresh')).toBeInTheDocument()
      act(() => void vi.advanceTimersByTime(100))
      expect(screen.getByText('Refresh')).toBeInTheDocument()
      act(() => void vi.advanceTimersByTime(140))
      expect(screen.queryByText('Refresh')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending show when the pointer leaves before the delay', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content="Settings">
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
        <Tooltip content="">
          <button>trigger</button>
        </Tooltip>,
      )
      fireEvent.mouseEnter(wrapper(container))
      act(() => void vi.advanceTimersByTime(600))
      // No tooltip role/box: the only thing on screen is the trigger button.
      expect(screen.getByText('trigger')).toBeInTheDocument()
      expect(document.body.querySelectorAll('.fixed')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('shows immediately with title + content and survives the pointer moving into it', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip title="OS Sandbox" content={<p>sandbox details</p>}>
          <span>icon</span>
        </Tooltip>,
      )
      const span = wrapper(container)

      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByText('OS Sandbox')).toBeInTheDocument()
      expect(screen.getByText('sandbox details')).toBeInTheDocument()
      const surface = screen.getByRole('tooltip')
      expect(surface).toHaveClass('transition-opacity')
      expect(surface).not.toHaveClass('animate-popover-in')

      // Leaving the trigger starts a grace period rather than hiding at once...
      fireEvent.mouseLeave(span)
      // ...and moving onto the card within that window keeps it open.
      const card = screen.getByText('sandbox details').closest('div.fixed') as HTMLElement
      fireEvent.mouseEnter(card)
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.getByText('OS Sandbox')).toBeInTheDocument()

      // Leaving the card for somewhere outside the trigger dismisses it. React
      // fires leave on both (the portal is a React child of the wrapper), so the
      // test models both.
      fireEvent.mouseLeave(card)
      fireEvent.mouseLeave(span)
      act(() => void vi.advanceTimersByTime(240))
      expect(screen.queryByText('OS Sandbox')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: the tooltip's arrow used to overhang onto the trigger, so nudging
  // the pointer within a 14px icon crossed card -> trigger. React's enter/leave
  // follow the REACT tree and the portal is a child of the wrapper, so that move
  // fires leave-on-card with NO enter-on-wrapper to answer it. Dismissing
  // straight from the card's leave therefore closed the card while the pointer
  // was still on the trigger, with nothing left to reopen it.
  it('stays open when the pointer moves from the card back onto the trigger', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content={<p>body</p>}>
          <span>icon</span>
        </Tooltip>,
      )
      const span = wrapper(container)
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(600))
      const card = screen.getByText('body').closest('div.fixed') as HTMLElement
      fireEvent.mouseEnter(card)

      // Pointer travels card -> trigger. React fires leave on the card and
      // propagates it to the wrapper too; relatedTarget is what says the pointer
      // actually landed back on the trigger.
      const icon = screen.getByText('icon')
      fireEvent.mouseLeave(card, { relatedTarget: icon })
      fireEvent.mouseLeave(span, { relatedTarget: icon })
      act(() => void vi.advanceTimersByTime(500))
      expect(screen.getByText('body')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not pin on click', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content={<p>body</p>}>
          <button>icon</button>
        </Tooltip>,
      )
      const span = wrapper(container)
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByText('body')).toBeInTheDocument()

      fireEvent.click(span)
      act(() => void vi.advanceTimersByTime(140))
      expect(screen.queryByText('body')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses after the grace period when the pointer never reaches the card', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content={<p>body</p>}>
          <span>icon</span>
        </Tooltip>,
      )
      const span = wrapper(container)
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByText('body')).toBeInTheDocument()

      fireEvent.mouseLeave(span)
      act(() => void vi.advanceTimersByTime(240))
      expect(screen.queryByText('body')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays mounted while text selection drags outside the tooltip', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <Tooltip content={<p>select this text</p>}>
          <span>icon</span>
        </Tooltip>,
      )
      const span = wrapper(container)
      fireEvent.mouseEnter(span)
      act(() => void vi.advanceTimersByTime(600))
      const box = screen.getByRole('tooltip')

      fireEvent.mouseDown(box, { button: 0 })
      fireEvent.mouseLeave(box)
      fireEvent.mouseLeave(span)
      act(() => void vi.advanceTimersByTime(1_000))
      expect(screen.getByText('select this text')).toBeInTheDocument()

      fireEvent.mouseUp(document)
      act(() => void vi.advanceTimersByTime(240))
      expect(screen.queryByText('select this text')).toBeNull()
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
      // The trigger is a real button (keyboard-reachable, 20px hit target)
      // wrapping the lucide Info svg; the card is hidden until hovered.
      const trigger = screen.getByRole('button', { name: 'Network Access help' })
      expect(trigger.querySelector('svg')).toBeTruthy()
      expect(container.querySelector('svg')).toBeTruthy()
      expect(screen.queryByText('Network Access')).toBeNull()

      fireEvent.mouseEnter(wrapper(container))
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByText('Network Access')).toBeInTheDocument()
      expect(screen.getByText('outbound network details')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
