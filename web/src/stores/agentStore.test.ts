import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAgentStore } from './agentStore'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'

// Helper: build a minimal-but-valid AgentResponse. `status` (when given) seeds
// agent_status; pass `unread` to set has_unread_changes.
function makeAgent(
  id: string,
  opts: { status?: AgentStatus; unread?: boolean } = {},
): AgentResponse {
  const a: AgentResponse = {
    id,
    project_path: '/proj',
    session_pid: 0,
    session_status: 'running',
    agent_type: 'claude',
    pre_prompt: '',
    prompt: '',
    base_branch: 'main',
  }
  if (opts.status !== undefined) {
    a.agent_status = { status: opts.status, timestamp: '2026-01-01T00:00:00Z' }
  }
  if (opts.unread !== undefined) {
    a.has_unread_changes = opts.unread
  }
  return a
}

const statusOf = (id: string) =>
  useAgentStore.getState().agents.find((a) => a.id === id)?.agent_status?.status

const unreadOf = (id: string) =>
  useAgentStore.getState().agents.find((a) => a.id === id)?.has_unread_changes

beforeEach(() => {
  // Pin the clock so Date.now()-based TTLs are deterministic.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-29T12:00:00Z'))
  // Reset the store to its freshly-created initial state between cases.
  useAgentStore.setState(useAgentStore.getInitialState(), true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('optimistic status override', () => {
  it('applies an optimistic status on top of setAgents data and wins until it expires', () => {
    const store = useAgentStore.getState

    // Backend currently reports RUNNING.
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    expect(statusOf('a1')).toBe(AgentStatus.RUNNING)

    // User submits a prompt → optimistically pin WAITING.
    store().setOptimisticStatus('a1', AgentStatus.WAITING)
    expect(statusOf('a1')).toBe(AgentStatus.WAITING)

    // A subsequent poll still reporting the stale RUNNING must NOT clobber the
    // override while it is live.
    vi.setSystemTime(new Date('2026-06-29T12:00:04Z')) // +4s, within 8s TTL
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    expect(statusOf('a1')).toBe(AgentStatus.WAITING)
    expect(useAgentStore.getState().optimistic['a1']).toBeDefined()

    // Past the TTL, a poll reporting RUNNING wins and the override is dropped.
    vi.setSystemTime(new Date('2026-06-29T12:00:09Z')) // +9s, past 8s TTL
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    expect(statusOf('a1')).toBe(AgentStatus.RUNNING)
    expect(useAgentStore.getState().optimistic['a1']).toBeUndefined()
  })

  it('drops the override early once the backend catches up to the optimistic status', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    store().setOptimisticStatus('a1', AgentStatus.FINISHED)
    expect(statusOf('a1')).toBe(AgentStatus.FINISHED)

    // Backend now reports FINISHED itself (matches the override) → override
    // served its purpose and is pruned even though the TTL hasn't elapsed.
    store().setAgents([makeAgent('a1', { status: AgentStatus.FINISHED })])
    expect(statusOf('a1')).toBe(AgentStatus.FINISHED)
    expect(useAgentStore.getState().optimistic['a1']).toBeUndefined()
  })

  it('honours a custom ttlMs', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    store().setOptimisticStatus('a1', AgentStatus.WAITING, 2_000)

    vi.setSystemTime(new Date('2026-06-29T12:00:01Z')) // +1s, within 2s
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    expect(statusOf('a1')).toBe(AgentStatus.WAITING)

    vi.setSystemTime(new Date('2026-06-29T12:00:03Z')) // +3s, past 2s
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    expect(statusOf('a1')).toBe(AgentStatus.RUNNING)
  })

  it('seeds agent_status on an agent that had none', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1')]) // no agent_status
    store().setOptimisticStatus('a1', AgentStatus.STARTING)
    expect(statusOf('a1')).toBe(AgentStatus.STARTING)
  })
})

describe('read override (markRead)', () => {
  it('forces has_unread_changes false on top of setAgents and expires after the TTL', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { unread: true })])
    expect(unreadOf('a1')).toBe(true)

    // Open the agent → optimistically mark read.
    store().markRead('a1')
    expect(unreadOf('a1')).toBe(false)

    // A poll still reporting unread within the TTL must not relight the dot.
    vi.setSystemTime(new Date('2026-06-29T12:00:04Z'))
    store().setAgents([makeAgent('a1', { unread: true })])
    expect(unreadOf('a1')).toBe(false)
    expect(useAgentStore.getState().readUntil['a1']).toBeDefined()

    // Past the TTL the backend's unread flag wins again.
    vi.setSystemTime(new Date('2026-06-29T12:00:09Z'))
    store().setAgents([makeAgent('a1', { unread: true })])
    expect(unreadOf('a1')).toBe(true)
    expect(useAgentStore.getState().readUntil['a1']).toBeUndefined()
  })

  it('drops the read override early once the backend reports the agent as read', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { unread: true })])
    store().markRead('a1')

    store().setAgents([makeAgent('a1', { unread: false })])
    expect(unreadOf('a1')).toBe(false)
    expect(useAgentStore.getState().readUntil['a1']).toBeUndefined()
  })

  it('clears any opposing unread override', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { unread: false })])
    store().markUnread('a1')
    expect(useAgentStore.getState().unreadUntil['a1']).toBeDefined()

    store().markRead('a1')
    expect(useAgentStore.getState().unreadUntil['a1']).toBeUndefined()
    expect(useAgentStore.getState().readUntil['a1']).toBeDefined()
    expect(unreadOf('a1')).toBe(false)
  })
})

describe('unread override (markUnread)', () => {
  it('forces has_unread_changes true on top of setAgents and expires after the TTL', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { unread: false })])
    expect(unreadOf('a1')).toBe(false)

    store().markUnread('a1')
    expect(unreadOf('a1')).toBe(true)

    // A poll still reporting read within the TTL must not clear the dot.
    vi.setSystemTime(new Date('2026-06-29T12:00:04Z'))
    store().setAgents([makeAgent('a1', { unread: false })])
    expect(unreadOf('a1')).toBe(true)
    expect(useAgentStore.getState().unreadUntil['a1']).toBeDefined()

    // Past the TTL the backend's (read) flag wins again.
    vi.setSystemTime(new Date('2026-06-29T12:00:09Z'))
    store().setAgents([makeAgent('a1', { unread: false })])
    expect(unreadOf('a1')).toBe(false)
    expect(useAgentStore.getState().unreadUntil['a1']).toBeUndefined()
  })

  it('drops the unread override early once the backend reports the agent as unread', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { unread: false })])
    store().markUnread('a1')

    store().setAgents([makeAgent('a1', { unread: true })])
    expect(unreadOf('a1')).toBe(true)
    expect(useAgentStore.getState().unreadUntil['a1']).toBeUndefined()
  })

  it('clears any opposing read override', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { unread: true })])
    store().markRead('a1')
    expect(useAgentStore.getState().readUntil['a1']).toBeDefined()

    store().markUnread('a1')
    expect(useAgentStore.getState().readUntil['a1']).toBeUndefined()
    expect(useAgentStore.getState().unreadUntil['a1']).toBeDefined()
    expect(unreadOf('a1')).toBe(true)
  })
})

describe('removeAgent prunes per-id overrides', () => {
  it('removes the agent and all three override kinds for that id only', () => {
    const store = useAgentStore.getState
    store().setAgents([
      makeAgent('a1', { status: AgentStatus.RUNNING, unread: true }),
      makeAgent('a2', { status: AgentStatus.RUNNING, unread: false }),
    ])

    // a1 gets a status + read override; a2 gets an unread override.
    store().setOptimisticStatus('a1', AgentStatus.WAITING)
    store().markRead('a1')
    store().markUnread('a2')

    expect(useAgentStore.getState().optimistic['a1']).toBeDefined()
    expect(useAgentStore.getState().readUntil['a1']).toBeDefined()
    expect(useAgentStore.getState().unreadUntil['a2']).toBeDefined()

    store().removeAgent('a1')

    const s = useAgentStore.getState()
    // a1 is gone from the list and from every override map.
    expect(s.agents.find((a) => a.id === 'a1')).toBeUndefined()
    expect(s.optimistic['a1']).toBeUndefined()
    expect(s.readUntil['a1']).toBeUndefined()
    expect(s.unreadUntil['a1']).toBeUndefined()

    // a2's override is untouched.
    expect(s.agents.find((a) => a.id === 'a2')).toBeDefined()
    expect(s.unreadUntil['a2']).toBeDefined()
  })
})

describe('overlays only touch matching ids', () => {
  it('leaves other agents in the polled list unmodified', () => {
    const store = useAgentStore.getState
    store().setOptimisticStatus('a1', AgentStatus.WAITING)
    store().setAgents([
      makeAgent('a1', { status: AgentStatus.RUNNING }),
      makeAgent('a2', { status: AgentStatus.RUNNING }),
    ])
    expect(statusOf('a1')).toBe(AgentStatus.WAITING)
    expect(statusOf('a2')).toBe(AgentStatus.RUNNING)
  })
})
