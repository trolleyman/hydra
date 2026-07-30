import { describe, it, expect, beforeEach } from 'vitest'
import { useServerUpdateStore } from './serverUpdateStore'

const store = () => useServerUpdateStore.getState()

beforeEach(() => {
  useServerUpdateStore.getState().reset()
})

describe('serverUpdateStore', () => {
  it('tracks phases and collects log lines', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'phase', phase: 'building' })
    store().apply({ kind: 'log', line: '$ mage build' })
    store().apply({ kind: 'log', line: 'ok' })

    expect(store().phase).toBe('building')
    expect(store().lines).toEqual(['$ mage build', 'ok'])
    expect(store().running).toBe(true)
    expect(store().outcome).toBeNull()
  })

  // The socket dying after "restarting" IS success: the server re-execs, so the
  // stream is severed before any terminal frame can be sent. Reporting that as an
  // error would make every successful update look like a failure.
  it('treats a socket closed during the restart as success', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'phase', phase: 'restarting' })
    store().socketClosed()

    expect(store().outcome).toBe('restarting')
    expect(store().error).toBeNull()
    expect(store().running).toBe(false)
  })

  // The swap is the point of no return - the binary is already installed - so a
  // socket lost there is also on its way back up, not a failure.
  it('treats a socket closed during the swap as success', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'phase', phase: 'swapping' })
    store().socketClosed()

    expect(store().outcome).toBe('restarting')
  })

  // Losing the server mid-BUILD is genuinely wrong: nothing had been swapped, so
  // whatever happened, it was not a restart.
  it('treats a socket closed mid-build as a failure', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'phase', phase: 'building' })
    store().socketClosed()

    expect(store().outcome).toBe('failed')
    expect(store().error).toMatch(/lost the connection/i)
  })

  it('records a failed build', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'phase', phase: 'building' })
    store().apply({ kind: 'log', line: 'undefined: resumeHeed' })
    store().apply({ kind: 'done', error: 'go build ./... failed: exit status 1' })

    expect(store().outcome).toBe('failed')
    expect(store().error).toBe('go build ./... failed: exit status 1')
    expect(store().running).toBe(false)
  })

  it('records a successful run', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'log', line: 'building' })
    store().apply({ kind: 'done' })

    expect(store().outcome).toBe('done')
    expect(store().error).toBeNull()
  })

  it('ignores a socket close once the run has already settled', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'done', error: 'boom' })
    store().socketClosed()

    expect(store().outcome).toBe('failed')
    expect(store().error).toBe('boom')
  })

  it('bounds the log so a long build cannot grow without limit', () => {
    store().begin({ restartOnly: false })
    for (let i = 0; i < 700; i++) store().apply({ kind: 'log', line: `line ${i}` })

    expect(store().lines).toHaveLength(500)
    expect(store().lines[0]).toBe('line 200')
    expect(store().lines.at(-1)).toBe('line 699')
  })

  // A daemon that predates the omitempty fix drops `line` entirely for a BLANK
  // line of build output, so the frame arrives as {kind:"log"} - and `mage build`
  // emits plenty of those. The undefined that used to land in `lines` reached
  // LogView, threw in hasAnsi, and took the whole app down mid-restart.
  it('keeps a log frame with no line as a blank line', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'log', line: 'building' })
    store().apply({ kind: 'log' } as never)

    expect(store().lines).toEqual(['building', ''])
  })

  it('begin clears the previous run', () => {
    store().begin({ restartOnly: false })
    store().apply({ kind: 'log', line: 'old' })
    store().apply({ kind: 'done', error: 'old failure' })

    store().begin({ restartOnly: true })
    expect(store().lines).toEqual([])
    expect(store().error).toBeNull()
    expect(store().outcome).toBeNull()
    expect(store().restartOnly).toBe(true)
    expect(store().running).toBe(true)
  })
})
