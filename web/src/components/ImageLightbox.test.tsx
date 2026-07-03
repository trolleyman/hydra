import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageLightbox, type LightboxImage } from './ImageLightbox'

// Two regression suites for the fullscreen lightbox:
//
// Closing - closing on backdrop click must require the pointer press to START on
// the backdrop: a drag that begins on the image (panning while zoomed, or
// dragging a diff slider) and releases past the image's edge makes the browser
// fire the trailing click on the press/release common ancestor - the backdrop -
// and that must NOT close the viewer.
//
// Focus management - the scenario that motivated it: open a lightbox while the
// terminal owns focus (xterm parks the keyboard on a hidden <textarea>). Without
// the focus steal, every keystroke kept feeding the shell and the X/B/A/H
// comparator shortcuts were swallowed by applyABShortcut's typing-in-a-field
// guard - so the lightbox looked keyboard-dead exactly when it was opened from
// the terminal. The lightbox must take focus for as long as it's up, and hand it
// back on close.
//
// ZoomPan (around the image / inside the comparator) needs a ResizeObserver;
// jsdom has none, and a no-op stub is fine - the zero-sized frame jsdom measures
// just means no minimap.
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterAll(() => vi.unstubAllGlobals())

// A plain (non-diff) entry: the closing suite only needs the single image + the
// backdrop around it.
const plainImage: LightboxImage = { url: 'shot.png', filename: 'shot.png', size: 1234 }

function renderPlainLightbox() {
  const onClose = vi.fn()
  render(<ImageLightbox images={[plainImage]} index={0} onIndexChange={() => {}} onClose={onClose} />)
  return { onClose, backdrop: screen.getByRole('dialog') }
}

describe('ImageLightbox closing', () => {
  it('closes when the backdrop is pressed and clicked directly', () => {
    const { onClose, backdrop } = renderPlainLightbox()
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when a drag starts on the image and the click lands on the backdrop', () => {
    const { onClose, backdrop } = renderPlainLightbox()
    const img = screen.getByAltText('shot.png')

    // Press on the image, release over the backdrop: the browser dispatches the
    // synthesized click on their common ancestor (the backdrop). Reproduced here
    // by pressing on the img and firing the click on the backdrop directly.
    fireEvent.pointerDown(img)
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 })
    fireEvent.pointerUp(window)
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()

    // A subsequent genuine backdrop click still closes (the press tracking resets).
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on clicks on the image itself', () => {
    const { onClose } = renderPlainLightbox()
    const img = screen.getByAltText('shot.png')
    fireEvent.pointerDown(img)
    fireEvent.click(img)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { onClose } = renderPlainLightbox()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// A diff entry, so the lightbox renders the before/after comparator whose
// Before/After toggle (aria-pressed) makes the X/B/A effects observable.
const diffImage: LightboxImage = {
  url: 'after.png',
  filename: 'home.png',
  size: 123,
  diff: { left: 'before.png', right: 'after.png', mode: 'ab' },
}

function renderDiffLightbox() {
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
    const { unmount } = renderDiffLightbox()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    unmount()
    expect(document.activeElement).toBe(terminal)
  })

  it('X/B/A reach the comparator when opened while the terminal had focus', () => {
    focusedTerminalInput()
    renderDiffLightbox()

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
    renderDiffLightbox()
    // No field of its own to type in, so simulate one gaining focus (matching,
    // say, a future caption/search box): keys targeted at it must not flip the view.
    const input = document.createElement('textarea')
    screen.getByRole('dialog').appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'b' })
    expect(screen.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true')
  })
})
