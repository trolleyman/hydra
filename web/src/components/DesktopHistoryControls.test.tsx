import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DesktopHistoryControls,
  type DesktopNavigationHistory,
} from './DesktopHistoryControls'

class TestHistory implements DesktopNavigationHistory {
  location = { state: { __TSR_index: 0 } }
  private furthest = 0
  private subscribers = new Set<(update: {
    location: { state: { __TSR_index: number } }
    action: { type: string }
  }) => void>()

  subscribe = (callback: (update: {
    location: { state: { __TSR_index: number } }
    action: { type: string }
  }) => void) => {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  push() {
    this.furthest = this.location.state.__TSR_index + 1
    this.move(this.furthest, 'PUSH')
  }

  back = () => {
    if (this.location.state.__TSR_index > 0) {
      this.move(this.location.state.__TSR_index - 1, 'BACK')
    }
  }

  forward = () => {
    if (this.location.state.__TSR_index < this.furthest) {
      this.move(this.location.state.__TSR_index + 1, 'FORWARD')
    }
  }

  private move(index: number, type: string) {
    this.location = { state: { __TSR_index: index } }
    this.subscribers.forEach((callback) => callback({ location: this.location, action: { type } }))
  }
}

afterEach(cleanup)

describe('DesktopHistoryControls', () => {
  it('enables back and forward as the history position changes', () => {
    const history = new TestHistory()
    render(<DesktopHistoryControls history={history} />)

    const back = screen.getByRole('button', { name: 'Back' })
    const forward = screen.getByRole('button', { name: 'Forward' })
    expect(back).toBeDisabled()
    expect(forward).toBeDisabled()

    act(() => history.push())
    expect(back).toBeEnabled()
    expect(forward).toBeDisabled()

    fireEvent.click(back)
    expect(back).toBeDisabled()
    expect(forward).toBeEnabled()

    fireEvent.click(forward)
    expect(back).toBeEnabled()
    expect(forward).toBeDisabled()
  })

  it('drops the forward branch after a new navigation', () => {
    const history = new TestHistory()
    render(<DesktopHistoryControls history={history} />)

    act(() => {
      history.push()
      history.push()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled()

    act(() => history.push())
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  })
})
