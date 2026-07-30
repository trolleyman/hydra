import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ArtifactLogLine, ArtifactSet } from '../api'
import { LiveLogPanes, LogView } from './ArtifactLogView'

// Regression guard for "a side that fails mid-generation reads as green"
// (artifacts: fix failed side reading as green mid-generation). While the set is
// still generating, a side that exited non-zero has its live log drained and a
// persisted log URL set - which on its own looks exactly like a clean finish.
// Only the per-side error tells them apart, so LiveLogColumn must colour from
// `error` first: red for a failure, green only for a settled side with none, and
// neutral grey while a side is still building.
//
// This lives here rather than in the e2e suite because it needs a set in a very
// specific transient shape; the simulation's "components" set used to model it,
// but was later repurposed to demo per-file tile streaming (both sides live).
afterEach(cleanup)

// jsdom has no fetch; a settled side tries to load its persisted log.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch in jsdom'))))

function set(over: Partial<ArtifactSet>): ArtifactSet {
  return { name: 'components', status: 'generating', files: [], ...over } as ArtifactSet
}

// The two panes in order: Before (left), After (right).
function borders(container: HTMLElement): string[] {
  return [...container.querySelectorAll('div.max-h-64')].map((el) => el.className)
}

describe('LiveLogPanes side colours', () => {
  it('paints a side that failed mid-generation red, not green', () => {
    const { container } = render(
      <LiveLogPanes
        set={set({
          left_error: "exited 1: error: Cannot find module 'playwright'",
          left_log_url: '/artifacts/log?side=left',
          right_log_url: null,
        })}
      />,
    )
    const [left, right] = borders(container)
    // The failed side is red even though its drained log + URL look "settled".
    expect(left).toMatch(/border-red-/)
    expect(left).not.toMatch(/border-green-/)
    // The other side is still building, so it stays neutral - not green.
    expect(right).not.toMatch(/border-(red|green)-/)
  })

  it('paints a side that settled cleanly green while the other still builds', () => {
    const { container } = render(
      <LiveLogPanes set={set({ left_log_url: '/artifacts/log?side=left', right_log_url: null })} />,
    )
    const [left, right] = borders(container)
    expect(left).toMatch(/border-green-/)
    expect(right).not.toMatch(/border-(red|green)-/)
  })

  it('leaves both sides neutral while both are still generating', () => {
    const { container } = render(<LiveLogPanes set={set({ left_log_url: null, right_log_url: null })} />)
    for (const cls of borders(container)) expect(cls).not.toMatch(/border-(red|green)-/)
  })
})

// LogView renders whatever a websocket handed it. `text` is required by the
// schema, but a frame that omitted it (the server-update stream's `omitempty` on
// a blank build line) used to throw inside hasAnsi - and a throw in a render
// effect unmounts the whole app, which is how one blank line of `mage build`
// output blanked the UI mid-restart.
describe('LogView malformed lines', () => {
  it('renders a line with no text instead of throwing', () => {
    const log = [
      { text: 'building', stream: 'stdout' },
      { stream: 'stdout' } as ArtifactLogLine,
      { text: 'done', stream: 'stdout' },
    ] as ArtifactLogLine[]
    expect(() => render(<LogView log={log} />)).not.toThrow()
  })
})
