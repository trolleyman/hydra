import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ClaudeUsageIndicator } from './ClaudeUsageIndicator'
import { api } from '../stores/apiClient'
import type { ClaudeUsageResponse } from '../api'

// Integration test for a migrated useServerData site (PLAN #57): the indicator is
// driven end-to-end through the real hook, with only the API call mocked. Mirrors
// the simulation server's snapshot (internal/http/simulation.go GetClaudeUsage):
// 38% session, 65% weekly, "Resets in 2h 15m" (and no session_resets_at, so the
// text path - not the live countdown - supplies the "reset" value).
const SNAPSHOT: ClaudeUsageResponse = {
  available: true,
  account_tier: 'Claude Max',
  session_percent_used: 38,
  weekly_percent_used: 65,
  session_reset_text: 'Resets in 2h 15m',
  weekly_reset_text: 'Resets Jan 15, 3:30pm',
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ClaudeUsageIndicator', () => {
  it('fetches on mount (unforced) and renders the usage snapshot', async () => {
    const spy = vi.spyOn(api.default, 'getClaudeUsage').mockResolvedValue(SNAPSHOT)
    render(<ClaudeUsageIndicator agentType="claude" />)

    // The visibility poll fires once immediately on mount; flush its microtask.
    await act(async () => { await Promise.resolve() })

    // Background poll → not a forced re-probe.
    expect(spy).toHaveBeenCalledWith(undefined)
    expect(screen.getByText('62%')).toBeInTheDocument()
    expect(screen.getByText('35%')).toBeInTheDocument()
    // "Resets in " prefix is stripped so only the duration sits under the label.
    expect(screen.getByText('2h 15m')).toBeInTheDocument()
  })

  it('forces a fresh probe when clicked', async () => {
    const spy = vi.spyOn(api.default, 'getClaudeUsage').mockResolvedValue(SNAPSHOT)
    render(<ClaudeUsageIndicator agentType="claude" />)
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      screen.getByLabelText('Claude usage').click()
      await Promise.resolve()
    })

    // The click routes through the hook's refetch(arg) → forced probe.
    expect(spy).toHaveBeenLastCalledWith(true)
  })

  it('shows the Codex snapshot when Codex is selected', async () => {
    const spy = vi.spyOn(api.default, 'getCodexUsage').mockResolvedValue({
      available: true,
      session_percent_used: 38,
      session_reset_text: '5h',
      weekly_percent_used: 65,
      weekly_reset_text: 'week',
    })
    render(<ClaudeUsageIndicator agentType="codex" />)
    await act(async () => { await Promise.resolve() })

    expect(spy).toHaveBeenCalledWith(undefined)
    expect(screen.getByLabelText('Codex usage')).toBeInTheDocument()
    expect(screen.getByText('62%')).toBeInTheDocument()
    expect(screen.getByText('35%')).toBeInTheDocument()
  })

  it('only shows a model-specific Codex session limit for its model, while keeping the weekly reset visible', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T20:00:00Z'))
    vi.spyOn(api.default, 'getCodexUsage').mockResolvedValue({
      available: true,
      session_percent_used: 38,
      session_reset_text: '5h',
      session_model: 'gpt-5.3-codex-spark',
      session_resets_at: '2026-09-07T00:59:00Z',
      weekly_percent_used: 65,
      weekly_reset_text: 'week',
      weekly_resets_at: '2026-09-13T19:59:00Z',
    })
    render(<ClaudeUsageIndicator agentType="codex" model="gpt-5.6-sol" />)
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByText('62%')).not.toBeInTheDocument()
    expect(screen.getByText('35%')).toBeInTheDocument()
    expect(screen.getByText('6d 23h 59m')).toBeInTheDocument()

    render(<ClaudeUsageIndicator agentType="codex" model="gpt-5.3-codex-spark" />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('62%')).toBeInTheDocument()
  })

  it('forces fresh probes just after the session reset until the snapshot advances', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T15:00:00Z'))
    const resetAt = '2026-07-30T15:01:00Z'
    const spy = vi.spyOn(api.default, 'getClaudeUsage').mockResolvedValue({
      ...SNAPSHOT,
      session_resets_at: resetAt,
    })
    render(<ClaudeUsageIndicator agentType="claude" />)
    await act(async () => { await Promise.resolve() })

    expect(spy).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000)
    })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenLastCalledWith(true)
  })

  it('cancels reset retries when a probe returns the next reset time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T15:00:00Z'))
    const oldReset = '2026-07-30T15:01:00Z'
    const nextReset = '2026-07-30T19:01:00Z'
    const spy = vi.spyOn(api.default, 'getClaudeUsage')
      .mockResolvedValueOnce({ ...SNAPSHOT, session_resets_at: oldReset })
      .mockResolvedValue({ ...SNAPSHOT, session_resets_at: nextReset })
    render(<ClaudeUsageIndicator agentType="claude" />)
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000)
    })
    expect(spy).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 31_000)
    })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('formats a reset more than one day away in days and hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T15:00:00Z'))
    const spy = vi.spyOn(api.default, 'getClaudeUsage').mockResolvedValue({
      ...SNAPSHOT,
      session_resets_at: '2026-08-05T00:49:00Z',
    })
    render(<ClaudeUsageIndicator agentType="claude" />)
    await act(async () => { await Promise.resolve() })

    expect(spy).toHaveBeenCalledWith(undefined)
    expect(screen.getByText('5d 9h 49m')).toBeInTheDocument()
  })

  it('renders nothing until data arrives', () => {
    vi.spyOn(api.default, 'getClaudeUsage').mockReturnValue(new Promise(() => {}) as ReturnType<typeof api.default.getClaudeUsage>)
    const { container } = render(<ClaudeUsageIndicator agentType="claude" />)
    expect(container).toBeEmptyDOMElement()
  })
})
