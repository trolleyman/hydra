import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useServerData } from './useServerData'

// startVisibilityPolling fires once immediately if the tab is visible, then on an
// interval. jsdom reports document.hidden === false, so the poll's immediate fire
// stands in for the initial load here.

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useServerData', () => {
  it('fetches on mount and exposes the result', async () => {
    const fetcher = vi.fn(async () => 'hello')
    const { result } = renderHook(() => useServerData<string>('k', fetcher, { initial: '' }))

    expect(result.current.data).toBe('')
    await act(async () => { await Promise.resolve() })
    expect(fetcher).toHaveBeenCalledWith('k', undefined)
    expect(result.current.data).toBe('hello')
  })

  it('stays idle and resets to initial when the key is null', async () => {
    const fetcher = vi.fn(async () => 'x')
    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useServerData<string>(key, fetcher, { initial: 'init' }),
      { initialProps: { key: 'k' as string | null } },
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toBe('x')

    rerender({ key: null })
    expect(result.current.data).toBe('init')
    const callsAfterDisable = fetcher.mock.calls.length
    // No further fetches happen while disabled.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetcher.mock.calls.length).toBe(callsAfterDisable)
  })

  it('refetch triggers a fresh fetch with a stable identity', async () => {
    const fetcher = vi.fn(async () => 'v')
    const { result, rerender } = renderHook(() => useServerData<string>('k', fetcher))
    await act(async () => { await Promise.resolve() })
    const firstRefetch = result.current.refetch

    rerender()
    // refetch identity must survive re-renders so it can be wired into an event handler.
    expect(result.current.refetch).toBe(firstRefetch)

    const before = fetcher.mock.calls.length
    await act(async () => { result.current.refetch() })
    expect(fetcher.mock.calls.length).toBe(before + 1)
  })

  it('forwards a refetch arg to the fetcher', async () => {
    const fetcher = vi.fn(async (_k: string, force?: boolean) => (force ? 'forced' : 'cached'))
    const { result } = renderHook(() => useServerData<string, boolean>('k', fetcher))
    await act(async () => { await Promise.resolve() })

    await act(async () => { result.current.refetch(true) })
    expect(fetcher).toHaveBeenLastCalledWith('k', true)
  })

  it('runs onData on success and swallows errors by default', async () => {
    const onData = vi.fn()
    const ok = renderHook(() => useServerData<string>('k', async () => 'ok', { onData }))
    await act(async () => { await Promise.resolve() })
    expect(onData).toHaveBeenCalledWith('ok')

    // A throwing fetcher keeps the last/initial value and does not surface.
    const bad = renderHook(() =>
      useServerData<string>('k', async () => { throw new Error('boom') }, { initial: 'kept' }),
    )
    await act(async () => { await Promise.resolve() })
    expect(bad.result.current.data).toBe('kept')
    ok.unmount(); bad.unmount()
  })

  it('resets to initial on error when resetOnError is set', async () => {
    let shouldThrow = false
    const { result } = renderHook(() =>
      useServerData<string>('k', async () => {
        if (shouldThrow) throw new Error('boom')
        return 'good'
      }, { initial: 'init', resetOnError: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toBe('good')

    shouldThrow = true
    // Flush the rejected fetch's microtasks (catch → finally) under fake timers.
    await act(async () => { result.current.refetch(); await Promise.resolve(); await Promise.resolve() })
    expect(result.current.data).toBe('init')
  })

  it('clears stale data when the key changes, but not on a dep-only change', async () => {
    const { result, rerender } = renderHook(
      ({ key, stamp }: { key: string; stamp: string }) =>
        useServerData<string>(key, async (k) => `data-for-${k}`, { initial: '', deps: [stamp] }),
      { initialProps: { key: 'a', stamp: '1' } },
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toBe('data-for-a')

    // Dep-only change: data is NOT cleared (would flicker the UI); it updates in place.
    rerender({ key: 'a', stamp: '2' })
    expect(result.current.data).toBe('data-for-a')
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toBe('data-for-a')

    // Key change: stale data is dropped synchronously, then the new key loads.
    rerender({ key: 'b', stamp: '2' })
    expect(result.current.data).toBe('')
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toBe('data-for-b')
  })

  it('refetches when a dep changes', async () => {
    const fetcher = vi.fn(async () => 'v')
    const { rerender } = renderHook(
      ({ stamp }: { stamp: string }) => useServerData<string>('k', fetcher, { deps: [stamp] }),
      { initialProps: { stamp: 'a' } },
    )
    await act(async () => { await Promise.resolve() })
    const before = fetcher.mock.calls.length

    rerender({ stamp: 'b' })
    await act(async () => { await Promise.resolve() })
    expect(fetcher.mock.calls.length).toBe(before + 1)
  })

  it('polls on the configured interval while visible', async () => {
    const fetcher = vi.fn(async () => 'v')
    renderHook(() => useServerData<string>('k', fetcher, { intervalMs: 1000 }))
    // Immediate fire on mount.
    await act(async () => { await Promise.resolve() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})
