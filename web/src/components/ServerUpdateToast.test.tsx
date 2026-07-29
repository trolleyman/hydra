import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ServerUpdateToast } from './ServerUpdateToast'
import { useServerUpdateStore } from '../stores/serverUpdateStore'

// Regression guard for "the Restarting... toast freezes its spinner".
//
// `running` goes false the instant the socket drops, and a dropped socket is
// exactly what a successful re-exec looks like - so the phase with the longest
// wait (the server is coming back up) was the one phase drawn with a static
// icon. The spinner has to key off "is there still something to wait for",
// which is every state except the two terminal outcomes.
afterEach(() => {
  cleanup()
  useServerUpdateStore.getState().reset()
})

const spinners = (c: HTMLElement) => c.querySelectorAll('.animate-spin').length

describe('ServerUpdateToast', () => {
  it('keeps spinning while the server restarts', () => {
    const store = useServerUpdateStore.getState()
    store.begin({ restartOnly: false })
    store.apply({ kind: 'phase', phase: 'restarting' })
    // The re-exec kills the socket without a terminal frame.
    useServerUpdateStore.getState().socketClosed()

    const { container } = render(<ServerUpdateToast />)
    expect(useServerUpdateStore.getState().outcome).toBe('restarting')
    expect(useServerUpdateStore.getState().running).toBe(false)
    expect(spinners(container)).toBe(1)
  })

  it('spins while building', () => {
    const store = useServerUpdateStore.getState()
    store.begin({ restartOnly: false })
    store.apply({ kind: 'phase', phase: 'building' })

    const { container } = render(<ServerUpdateToast />)
    expect(spinners(container)).toBe(1)
  })

  it('stops once the run reaches a terminal outcome', () => {
    const store = useServerUpdateStore.getState()
    store.begin({ restartOnly: false })
    store.apply({ kind: 'done' })

    const { container } = render(<ServerUpdateToast />)
    expect(useServerUpdateStore.getState().outcome).toBe('done')
    expect(spinners(container)).toBe(0)
  })

  it('stops on failure', () => {
    const store = useServerUpdateStore.getState()
    store.begin({ restartOnly: false })
    store.apply({ kind: 'done', error: 'build failed' })

    const { container } = render(<ServerUpdateToast />)
    expect(spinners(container)).toBe(0)
  })
})
