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
