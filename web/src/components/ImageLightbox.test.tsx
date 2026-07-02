import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageLightbox, type LightboxImage } from './ImageLightbox'

// Focus management + keyboard regression tests for the fullscreen lightbox. The
// scenario that motivated these: open a lightbox while the terminal owns focus
// (xterm parks the keyboard on a hidden <textarea>). Without the focus steal,
// every keystroke kept feeding the shell and the X/B/A/H comparator shortcuts
// were swallowed by applyABShortcut's typing-in-a-field guard — so the lightbox
// looked keyboard-dead exactly when it was opened from the terminal. The
// lightbox must take focus for as long as it's up, and hand it back on close.
// ZoomPan (inside the comparator) needs a ResizeObserver; jsdom has none.
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterAll(() => vi.unstubAllGlobals())

// A diff entry, so the lightbox renders the before/after comparator whose
// Before/After toggle (aria-pressed) makes the X/B/A effects observable.
const diffImage: LightboxImage = {
  url: 'after.png',
  filename: 'home.png',
  size: 123,
  diff: { left: 'before.png', right: 'after.png', mode: 'ab' },
}

function renderLightbox() {
  return render(
    <ImageLightbox images={[diffImage]} index={0} onIndexChange={vi.fn()} onClose={vi.fn()} />,
  )
}

// Stands in for xterm's hidden textarea: focused before the lightbox opens.
function focusedTerminalInput() {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

afterEach(() => document.querySelectorAll('textarea').forEach((t) => t.remove()))

describe('ImageLightbox focus management', () => {
  it('steals focus from the opener on mount and restores it on close', () => {
    const terminal = focusedTerminalInput()
    const { unmount } = renderLightbox()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    unmount()
    expect(document.activeElement).toBe(terminal)
  })

  it('X/B/A reach the comparator when opened while the terminal had focus', () => {
    focusedTerminalInput()
    renderLightbox()

    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed')

    // The view starts on After; keys land on the now-focused dialog, so the
    // typing-in-a-field guard no longer applies.
    expect(pressed('After')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'b' })
    expect(pressed('Before')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'x' })
    expect(pressed('After')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'x' })
    expect(pressed('Before')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    expect(pressed('After')).toBe('true')
  })

  it('still ignores the shortcuts while typing in a field inside the dialog', () => {
    renderLightbox()
    // No field of its own to type in, so simulate one gaining focus (matching,
    // say, a future caption/search box): keys targeted at it must not flip the view.
    const input = document.createElement('textarea')
    screen.getByRole('dialog').appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'b' })
    expect(screen.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true')
  })
})
