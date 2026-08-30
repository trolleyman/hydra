import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { selectLiveAgent, useAgentStore } from './agentStore'
import { useToastStore } from './toastStore'
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
  selectLiveAgent(useAgentStore.getState(), id)?.agent_status?.status

const unreadOf = (id: string) =>
  selectLiveAgent(useAgentStore.getState(), id)?.has_unread_changes

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
    expect(selectLiveAgent(s, 'a1')).toBeUndefined()
    expect(s.optimistic['a1']).toBeUndefined()
    expect(s.readUntil['a1']).toBeUndefined()
    expect(s.unreadUntil['a1']).toBeUndefined()

    // a2's override is untouched.
    expect(selectLiveAgent(s, 'a2')).toBeDefined()
    expect(s.unreadUntil['a2']).toBeDefined()
  })
})

describe('patchAgentStatus (agent_status_changed in-place patch)', () => {
  const agentStatusOf = (id: string) =>
    selectLiveAgent(useAgentStore.getState(), id)?.agent_status

  it('patches status, activity and last_message in place', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    store().patchAgentStatus('a1', {
      status: 'running',
      activity: 'Editing main.go',
      last_message: '',
      last_message_is_suggested: false,
    })
    const s = agentStatusOf('a1')
    expect(s?.status).toBe(AgentStatus.RUNNING)
    expect(s?.activity).toBe('Editing main.go')

    // A finish patch clears activity, sets the last message + suggested flag.
    store().patchAgentStatus('a1', {
      status: 'finished',
      activity: '',
      last_message: 'run it',
      last_message_is_suggested: true,
    })
    const f = agentStatusOf('a1')
    expect(f?.status).toBe(AgentStatus.FINISHED)
    expect(f?.activity).toBeUndefined()
    expect(f?.last_message).toBe('run it')
    expect(f?.last_message_is_suggested_next_message).toBe(true)
  })

  it('respects an active optimistic status override but still patches activity', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    // User just submitted → optimistically WAITING.
    store().setOptimisticStatus('a1', AgentStatus.WAITING)
    // A slightly-stale pushed status must NOT flip the badge back to RUNNING...
    store().patchAgentStatus('a1', {
      status: 'running',
      activity: 'Reading foo.go',
      last_message: '',
      last_message_is_suggested: false,
    })
    const s = agentStatusOf('a1')
    expect(s?.status).toBe(AgentStatus.WAITING)
    // ...but activity (which has no optimistic layer) still updates.
    expect(s?.activity).toBe('Reading foo.go')
  })

  it('is a no-op for an unknown id', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('a1', { status: AgentStatus.RUNNING })])
    const before = useAgentStore.getState().agents
    store().patchAgentStatus('nope', {
      status: 'running', activity: 'x', last_message: '', last_message_is_suggested: false,
    })
    // Same array reference back: nothing re-rendered.
    expect(useAgentStore.getState().agents).toBe(before)
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

describe('seedAgents (cached list painted while the real fetch is in flight)', () => {
  it('shows the cached agents but leaves loading true, so nothing treats them as the server list', () => {
    const store = useAgentStore.getState
    store().setAgents([makeAgent('old-project-agent')], 'A')
    expect(useAgentStore.getState().loading).toBe(false)

    store().seedAgents([makeAgent('cached')])

    const s = useAgentStore.getState()
    expect(s.agents.map((a) => a.id)).toEqual(['cached'])
    expect(s.loading).toBe(true)
    // Tagged as belonging to no project: the fetch that follows must read as a
    // project switch, not a same-project refresh.
    expect(s.agentsProjectId).toBeNull()
  })

  it('does not let a stale cache fire a background-merge toast when the real list lands', () => {
    const store = useAgentStore.getState
    const toasts = vi.spyOn(useToastStore.getState(), 'show')

    // Cached armed agent that the server no longer lists (merged days ago).
    const armed = { ...makeAgent('armed'), merge_when_green: true }
    store().seedAgents([armed])
    store().setAgents([makeAgent('other')], 'B')

    expect(toasts).not.toHaveBeenCalled()
    expect(useAgentStore.getState().loading).toBe(false)
    toasts.mockRestore()
  })
})

describe('upsertArchived insert position', () => {
  // The archived history is ordered by when a head was killed/merged (see
  // db.ListArchivedAgents), so an optimistic insert must use the same key -
  // otherwise a just-killed long-lived head lands halfway down the list and
  // jumps to the top on the next fetch.
  const archived = (id: string, created: number, archivedAt?: number): AgentResponse => ({
    ...makeAgent(id),
    archived: true,
    end_state: 'merged',
    created_at: created,
    ...(archivedAt === undefined ? {} : { archived_at: archivedAt }),
  })
  const ids = () => useAgentStore.getState().archived.map((a) => a.id)

  it('places a newly-archived old head at the top, not in created-at order', () => {
    useAgentStore.getState().setArchivedFirstPage([
      archived('closed-yesterday', 5_000, 9_000),
      archived('closed-last-week', 8_000, 3_000),
    ])
    // Spawned before both, closed just now.
    useAgentStore.getState().upsertArchived(archived('ancient-but-just-closed', 1_000, 10_000))
    expect(ids()).toEqual(['ancient-but-just-closed', 'closed-yesterday', 'closed-last-week'])
  })

  it('falls back to created_at for a legacy row with no archive time', () => {
    useAgentStore.getState().setArchivedFirstPage([
      archived('recent', 5_000, 5_000),
      archived('legacy', 2_000),
    ])
    useAgentStore.getState().upsertArchived(archived('legacy-newer', 3_000))
    expect(ids()).toEqual(['recent', 'legacy-newer', 'legacy'])
  })
})
