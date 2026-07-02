import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToastStore } from './toastStore'

const toasts = () => useToastStore.getState().toasts
const ids = () => toasts().map((t) => t.id)

beforeEach(() => {
  vi.useFakeTimers()
  useToastStore.setState(useToastStore.getInitialState(), true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toast lifetime', () => {
  it('auto-dismisses after its duration', () => {
    useToastStore.getState().show({ message: 'hi', duration: 3000 })
    expect(toasts()).toHaveLength(1)

    // Expiry flags it exiting, then removes it one exit-animation later.
    vi.advanceTimersByTime(3000)
    expect(toasts()[0].exiting).toBe(true)
    vi.advanceTimersByTime(220)
    expect(toasts()).toHaveLength(0)
  })

  it('keeps a persistent toast (duration 0) until dismissed', () => {
    const id = useToastStore.getState().show({ message: 'stay', duration: 0 })
    vi.advanceTimersByTime(60_000)
    expect(toasts()).toHaveLength(1)

    useToastStore.getState().dismiss(id)
    vi.advanceTimersByTime(220)
    expect(toasts()).toHaveLength(0)
  })
})

describe('pause/resume on hover', () => {
  it('suspends the auto-dismiss timer while paused, then resumes from the remaining time', () => {
    const id = useToastStore.getState().show({ message: 'hover me', duration: 3000 })

    // Burn 1s of the 3s lifetime, then pause: the toast must not expire no matter
    // how long the pointer lingers.
    vi.advanceTimersByTime(1000)
    useToastStore.getState().pause(id)
    expect(toasts()[0].paused).toBe(true)

    vi.advanceTimersByTime(60_000)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].exiting).toBe(false)

    // Resume: only the remaining 2s should be left.
    useToastStore.getState().resume(id)
    expect(toasts()[0].paused).toBe(false)

    vi.advanceTimersByTime(1999)
    expect(toasts()[0].exiting).toBe(false)
    vi.advanceTimersByTime(1)
    expect(toasts()[0].exiting).toBe(true)
  })

  it('is a no-op for a persistent toast (no timer to pause)', () => {
    const id = useToastStore.getState().show({ message: 'stay', duration: 0 })
    useToastStore.getState().pause(id)
    // No timer exists, so `paused` stays unset and the toast never expires.
    expect(toasts()[0].paused).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(toasts()).toHaveLength(1)
  })
})

describe('keyed dedup', () => {
  it('replaces the live toast carrying the same key instead of stacking', () => {
    const a = useToastStore.getState().show({ message: 'first', key: 'k', duration: 0 })
    const b = useToastStore.getState().show({ message: 'second', key: 'k', duration: 0 })

    expect(a).toBe(b) // same id reused
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toBe('second')
  })

  it('does not reuse a key whose toast is already exiting', () => {
    const a = useToastStore.getState().show({ message: 'first', key: 'k', duration: 0 })
    useToastStore.getState().dismiss(a) // now exiting, still briefly in the list
    const b = useToastStore.getState().show({ message: 'second', key: 'k', duration: 0 })

    expect(b).not.toBe(a)
    expect(ids()).toContain(b)
  })
})

describe('onDismiss (deny-on-dismiss)', () => {
  it('fires onDismiss on a normal dismiss', () => {
    const onDismiss = vi.fn()
    const id = useToastStore.getState().show({ message: 'gate', duration: 0, onDismiss })

    useToastStore.getState().dismiss(id)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('skips onDismiss on a silent dismiss', () => {
    const onDismiss = vi.fn()
    const id = useToastStore.getState().show({ message: 'gate', duration: 0, onDismiss })

    useToastStore.getState().dismiss(id, { silent: true })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not fire onDismiss twice on a double dismiss', () => {
    const onDismiss = vi.fn()
    const id = useToastStore.getState().show({ message: 'gate', duration: 0, onDismiss })

    useToastStore.getState().dismiss(id)
    useToastStore.getState().dismiss(id)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
