import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { useRef } from 'react'
import { RelativeTime, Uptime } from './LiveTime'

// The relative-time labels self-tick off a shared 1s clock (useNowTick) so they
// update WITHOUT their parent re-rendering. These tests pin the clock and drive
// the timer to prove the label advances, and that the parent renders exactly
// once (the isolation guarantee that fixes the page-wide-re-render jank).
afterEach(cleanup)
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

describe('RelativeTime', () => {
  it('advances its label each second without re-rendering the parent', () => {
    vi.setSystemTime(new Date('2026-07-06T12:00:00Z'))
    const createdAt = Math.floor(Date.parse('2026-07-06T11:59:50Z') / 1000) // 10s ago

    let parentRenders = 0
    function Parent() {
      parentRenders++
      useRef(null)
      return <div>up: <RelativeTime createdAt={createdAt} /></div>
    }
    render(<Parent />)
    expect(screen.getByText(/10s ago/)).toBeTruthy()
    expect(parentRenders).toBe(1)

    advance(3000)
    expect(screen.getByText(/13s ago/)).toBeTruthy()
    // The parent never re-rendered - only the isolated label did.
    expect(parentRenders).toBe(1)
  })
})

describe('Uptime', () => {
  it('advances using the shared now and the provided formatter', () => {
    vi.setSystemTime(new Date('2026-07-06T12:00:00Z'))
    const spawnedAt = Date.parse('2026-07-06T11:59:30Z') // up 30s
    const fmt = (ms: number) => `up ${Math.floor(ms / 1000)}s`

    render(<Uptime spawnedAt={spawnedAt} format={fmt} />)
    expect(screen.getByText('up 30s')).toBeTruthy()
    advance(5000)
    expect(screen.getByText('up 35s')).toBeTruthy()
  })
})
