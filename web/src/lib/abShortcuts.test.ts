import { describe, it, expect, vi } from 'vitest'
import { applyABShortcut, type ABShortcutTarget } from './abShortcuts'

// The shared X/B/A/H comparator shortcut mapping, used by both the diff grid
// (ArtifactsPanel) and the lightbox comparator (Lightbox). Regression for the
// grid only ever binding B: X must flip, B/A must jump to a side, everywhere.

function target(view: 'before' | 'after' = 'after', highlight = false) {
  return {
    view,
    highlight,
    onViewChange: vi.fn(),
    onHighlightChange: vi.fn(),
  } satisfies ABShortcutTarget
}

function key(k: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key: k, cancelable: true, ...init })
}

describe('applyABShortcut', () => {
  it('X flips the view both ways', () => {
    const fromAfter = target('after')
    expect(applyABShortcut(key('x'), fromAfter)).toBe(true)
    expect(fromAfter.onViewChange).toHaveBeenCalledWith('before')

    const fromBefore = target('before')
    applyABShortcut(key('x'), fromBefore)
    expect(fromBefore.onViewChange).toHaveBeenCalledWith('after')
  })

  it('B jumps to Before and A jumps to After regardless of the current view', () => {
    const onBefore = target('before')
    applyABShortcut(key('b'), onBefore)
    expect(onBefore.onViewChange).toHaveBeenCalledWith('before')
    applyABShortcut(key('a'), onBefore)
    expect(onBefore.onViewChange).toHaveBeenCalledWith('after')
  })

  it('H toggles the highlight', () => {
    const off = target('after', false)
    applyABShortcut(key('h'), off)
    expect(off.onHighlightChange).toHaveBeenCalledWith(true)

    const on = target('after', true)
    applyABShortcut(key('h'), on)
    expect(on.onHighlightChange).toHaveBeenCalledWith(false)
  })

  it('accepts uppercase keys (shift held)', () => {
    const t = target('after')
    expect(applyABShortcut(key('A', { shiftKey: true }), t)).toBe(true)
    expect(t.onViewChange).toHaveBeenCalledWith('after')
  })

  it('consumes the event it handles and ignores other keys', () => {
    const t = target()
    const handled = key('x')
    applyABShortcut(handled, t)
    expect(handled.defaultPrevented).toBe(true)

    const other = key('j')
    expect(applyABShortcut(other, t)).toBe(false)
    expect(other.defaultPrevented).toBe(false)
    expect(t.onViewChange).toHaveBeenCalledTimes(1)
  })

  it('lets browser chords through (Ctrl/Meta/Alt held)', () => {
    const t = target()
    expect(applyABShortcut(key('h', { ctrlKey: true }), t)).toBe(false)
    expect(applyABShortcut(key('a', { metaKey: true }), t)).toBe(false)
    expect(applyABShortcut(key('b', { altKey: true }), t)).toBe(false)
    expect(t.onViewChange).not.toHaveBeenCalled()
    expect(t.onHighlightChange).not.toHaveBeenCalled()
  })

  it('does nothing while typing in a field', () => {
    const t = target()
    for (const tag of ['input', 'textarea', 'select'] as const) {
      const el = document.createElement(tag)
      document.body.appendChild(el)
      const e = key('a')
      // KeyboardEvent.target is read-only; dispatching through the element sets it.
      el.addEventListener('keydown', (ev) => applyABShortcut(ev, t))
      el.dispatchEvent(e)
      el.remove()
    }
    const editable = document.createElement('div')
    // jsdom doesn't wire the contentEditable attribute up to isContentEditable.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    document.body.appendChild(editable)
    editable.addEventListener('keydown', (ev) => applyABShortcut(ev, t))
    editable.dispatchEvent(key('a'))
    editable.remove()

    expect(t.onViewChange).not.toHaveBeenCalled()
  })
})
