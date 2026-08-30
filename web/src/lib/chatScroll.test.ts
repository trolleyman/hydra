import { describe, expect, it } from 'vitest'
import { historyThresholdTransition, isVerticalScrollbarPointer } from './chatScroll'

describe('isVerticalScrollbarPointer', () => {
  it('recognises the native scrollbar gutter', () => {
    const element = document.createElement('div')
    Object.defineProperties(element, {
      offsetWidth: { value: 500 },
      clientWidth: { value: 485 },
    })
    element.getBoundingClientRect = () => ({
      x: 20, y: 0, left: 20, right: 520, top: 0, bottom: 600,
      width: 500, height: 600, toJSON: () => ({}),
    })
    expect(isVerticalScrollbarPointer(element, 510)).toBe(true)
    expect(isVerticalScrollbarPointer(element, 500)).toBe(false)
  })

  it('reserves a usable gutter for overlay scrollbars', () => {
    const element = document.createElement('div')
    Object.defineProperties(element, {
      offsetWidth: { value: 500 },
      clientWidth: { value: 500 },
    })
    element.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, right: 500, top: 0, bottom: 600,
      width: 500, height: 600, toJSON: () => ({}),
    })
    expect(isVerticalScrollbarPointer(element, 490)).toBe(true)
  })
})

describe('historyThresholdTransition', () => {
  it('requests only once while a scrollbar drag remains in the load zone', () => {
    const first = historyThresholdTransition(20, true, true)
    expect(first).toEqual({ armed: false, request: true })
    expect(historyThresholdTransition(20, first.armed, true)).toEqual({ armed: false, request: false })
    // An anchored prepend can move the viewport away from the top, but the held
    // thumb must not re-arm paging until the drag ends.
    expect(historyThresholdTransition(600, first.armed, true)).toEqual({ armed: false, request: false })
  })

  it('re-arms after an ordinary scroll leaves the load zone', () => {
    expect(historyThresholdTransition(600, false, false)).toEqual({ armed: true, request: false })
  })
})
