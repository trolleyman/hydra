import { afterEach, describe, expect, it, vi } from 'vitest'
import { queueMeasure } from './diffMetrics'

describe('queueMeasure', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('splits fallback work across frames when a measurement consumes its budget', () => {
    vi.useFakeTimers()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const completed: number[] = []

    for (let i = 1; i <= 3; i++) {
      queueMeasure(() => {
        completed.push(i)
        elapsed += 7
      })
    }

    vi.advanceTimersByTime(16)
    expect(completed).toEqual([1])
    vi.advanceTimersByTime(16)
    expect(completed).toEqual([1, 2])
    vi.advanceTimersByTime(16)
    expect(completed).toEqual([1, 2, 3])
  })
})
