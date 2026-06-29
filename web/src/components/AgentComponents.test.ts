import { describe, it, expect } from 'vitest'
import { statusDotClass, agentDotClass } from './AgentComponents'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'

// Helper: build a minimal-but-valid AgentResponse. `session` seeds the raw
// sandbox session status; `status` (when given) seeds agent_status, the richer
// signal agentDotClass prefers.
function makeAgent(
  opts: { session?: string; status?: AgentStatus } = {},
): AgentResponse {
  const a: AgentResponse = {
    id: 'a',
    project_path: '/proj',
    session_pid: 0,
    session_status: opts.session ?? 'running',
    agent_type: 'claude',
    pre_prompt: '',
    prompt: '',
    base_branch: 'main',
  }
  if (opts.status !== undefined) {
    a.agent_status = { status: opts.status, timestamp: '2026-01-01T00:00:00Z' }
  }
  return a
}

const GRAY = 'bg-gray-300 dark:bg-gray-600'

describe('statusDotClass', () => {
  // statusDotClass switches on the raw sandbox session_status. The backend only
  // ever emits pending|building|starting|running|stopped|exited (db model_*.go,
  // heads/heads.go) — never Docker's legacy `Up …`/`Exited (…)`/`created`
  // strings — so only running and exited get a dedicated colour; everything else
  // (including the pre-session states) falls through to the muted grey dot.
  it('maps running to green', () => {
    expect(statusDotClass('running')).toBe('bg-green-500')
  })

  it('maps exited to red', () => {
    expect(statusDotClass('exited')).toBe('bg-red-400')
  })

  it.each(['stopped', 'pending', 'starting', 'building'])(
    'maps the pre/post-session status %s to grey',
    (s) => {
      expect(statusDotClass(s)).toBe(GRAY)
    },
  )

  it('falls back to grey for an unknown status', () => {
    expect(statusDotClass('whatever')).toBe(GRAY)
  })

  // Regression guard for PLAN #64b: the removed normalizeContainerState used to
  // coerce Docker status strings ("Up 2 minutes", "Exited (0)", "created"). The
  // backend no longer produces them, so they are now treated as unknown → grey
  // rather than being special-cased. This pins that the Docker handling is gone.
  it.each(['Up 2 minutes', 'Exited (0) 3 seconds ago', 'created'])(
    'no longer special-cases the legacy Docker string %s',
    (s) => {
      expect(statusDotClass(s)).toBe(GRAY)
    },
  )
})

describe('agentDotClass', () => {
  it('prefers agent_status over the raw session status', () => {
    // session is "running" (green) but the agent is waiting on the user → yellow.
    const agent = makeAgent({ session: 'running', status: AgentStatus.WAITING })
    expect(agentDotClass(agent)).toBe('bg-yellow-400')
  })

  it.each([
    [AgentStatus.RUNNING, 'bg-green-500'],
    [AgentStatus.MERGING, 'bg-green-500'],
    [AgentStatus.NEEDS_INPUT, 'bg-red-500'],
    [AgentStatus.WAITING, 'bg-yellow-400'],
    [AgentStatus.FINISHED, 'bg-violet-500'],
    [AgentStatus.STARTING, 'bg-blue-400'],
    [AgentStatus.BUILDING, 'bg-blue-400'],
    [AgentStatus.KILLING, 'bg-red-400'],
    [AgentStatus.PENDING, GRAY],
    [AgentStatus.STOPPED, GRAY],
  ])('maps agent_status %s to its dot colour', (status, expected) => {
    expect(agentDotClass(makeAgent({ status }))).toBe(expected)
  })

  it('falls back to the session status when no agent_status is reported', () => {
    expect(agentDotClass(makeAgent({ session: 'running' }))).toBe('bg-green-500')
    expect(agentDotClass(makeAgent({ session: 'exited' }))).toBe('bg-red-400')
    expect(agentDotClass(makeAgent({ session: 'stopped' }))).toBe(GRAY)
  })
})
