import { describe, it, expect } from 'vitest'
import { statusDotClass, agentDotClass, agentStatusBadge, archivedEndStateBadge } from './AgentComponents'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'
import { TONE_DOT, TONE_BADGE } from './Badge'

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

// PLAN #65: the status badge helpers and the dots now derive from one set of tone
// tables (Badge.tsx). These pin that the consolidation preserved every status'
// label + colour, so a tone change lights up exactly the affected statuses.
describe('agentStatusBadge', () => {
  it.each([
    ['pending', 'pending', TONE_BADGE.neutral],
    ['building', 'building', TONE_BADGE.blue],
    ['deploying', 'deploying', TONE_BADGE.indigo],
    ['running', 'running', TONE_BADGE.green],
    ['starting', 'starting', TONE_BADGE.blue],
    ['needs_input', 'needs_input', TONE_BADGE.red],
    ['waiting', 'waiting', TONE_BADGE.yellow],
    ['finished', 'finished', TONE_BADGE.violet],
    ['merging', 'merging', TONE_BADGE.green],
    ['ended', 'ended', TONE_BADGE.muted],
    ['exited', 'exited', TONE_BADGE.red],
  ])('%s → { %s, … }', (status, label, className) => {
    expect(agentStatusBadge(status)).toEqual({ label, className })
  })

  it('renders statuses without a chip of their own with the dim faint fill', () => {
    expect(agentStatusBadge('killing')).toEqual({ label: 'killing', className: TONE_BADGE.faint })
    expect(agentStatusBadge('stopped')).toEqual({ label: 'stopped', className: TONE_BADGE.faint })
  })

  it('handles an unknown / missing status with a faint, echoed label', () => {
    expect(agentStatusBadge('mystery')).toEqual({ label: 'mystery', className: TONE_BADGE.faint })
    expect(agentStatusBadge(undefined)).toEqual({ label: '', className: TONE_BADGE.faint })
  })

  it('keeps the literal class values stable', () => {
    expect(agentStatusBadge('running').className).toBe('bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400')
    expect(agentStatusBadge('ended').className).toBe('bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400')
    expect(agentStatusBadge(undefined).className).toBe('bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500')
  })
})

describe('archivedEndStateBadge', () => {
  it.each([
    ['merged', 'merged'],
    ['killed', 'killed'],
  ])('%s → %s, muted', (endState, label) => {
    expect(archivedEndStateBadge(endState)).toEqual({ label, className: TONE_BADGE.muted })
  })

  it('falls back to the "archived" label for any other / missing end state', () => {
    expect(archivedEndStateBadge('purged')).toEqual({ label: 'archived', className: TONE_BADGE.muted })
    expect(archivedEndStateBadge(null)).toEqual({ label: 'archived', className: TONE_BADGE.muted })
    expect(archivedEndStateBadge(undefined)).toEqual({ label: 'archived', className: TONE_BADGE.muted })
  })
})

describe('dot and badge derive from the same tone', () => {
  // The point of the consolidation: a status' dot and its badge are two views of
  // the same tone, so for the statuses that carry both they can never drift apart.
  it.each([
    [AgentStatus.RUNNING, 'green'],
    [AgentStatus.MERGING, 'green'],
    [AgentStatus.NEEDS_INPUT, 'red'],
    [AgentStatus.WAITING, 'yellow'],
    [AgentStatus.FINISHED, 'violet'],
    [AgentStatus.STARTING, 'blue'],
    [AgentStatus.BUILDING, 'blue'],
  ] as const)('%s shares one tone across dot and badge', (status, tone) => {
    expect(agentDotClass(makeAgent({ status }))).toBe(TONE_DOT[tone])
    expect(agentStatusBadge(status).className).toBe(TONE_BADGE[tone])
  })
})
