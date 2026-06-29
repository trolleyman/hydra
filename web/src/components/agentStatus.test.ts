import { describe, it, expect } from 'vitest'
import type { AgentResponse } from '../api'
import {
  normalizeContainerState,
  statusDotClass,
  agentDotClass,
  agentStatusBadge,
  archivedEndStateBadge,
} from './AgentComponents'
import { TONE_DOT, TONE_BADGE } from './Badge'

// These tests pin the consolidated status-color contract (PLAN #65): every status
// must resolve to exactly the dot/badge colors it did before the four switch
// statements were collapsed onto the shared tone tables. They are the regression
// net for "one source of truth" — change a tone and the affected statuses light up.

function agent(status: string | undefined, session = ''): AgentResponse {
  return {
    agent_status: status ? { status } : undefined,
    session_status: session,
  } as unknown as AgentResponse
}

describe('normalizeContainerState', () => {
  it('folds the docker-era container states onto the canonical set', () => {
    expect(normalizeContainerState('Up 2 minutes')).toBe('running')
    expect(normalizeContainerState('running')).toBe('running')
    expect(normalizeContainerState('Exited (0) 1s ago')).toBe('exited')
    expect(normalizeContainerState('created')).toBe('created')
  })
  it('passes through unknown states lowercased', () => {
    expect(normalizeContainerState('Weird')).toBe('weird')
  })
})

describe('statusDotClass (session status → dot)', () => {
  it.each([
    ['running', TONE_DOT.green],
    ['Up 30 seconds', TONE_DOT.green],
    ['exited', TONE_DOT.redSoft],
    ['created', TONE_DOT.blue],
    ['', TONE_DOT.neutral],
    ['nonsense', TONE_DOT.neutral],
  ])('%s → %s', (session, expected) => {
    expect(statusDotClass(session)).toBe(expected)
  })

  it('keeps the literal class values stable', () => {
    expect(statusDotClass('running')).toBe('bg-green-500')
    expect(statusDotClass('exited')).toBe('bg-red-400')
    expect(statusDotClass('created')).toBe('bg-blue-400')
    expect(statusDotClass('')).toBe('bg-gray-300 dark:bg-gray-600')
  })
})

describe('agentDotClass (agent status → dot, session fallback)', () => {
  it.each([
    ['running', TONE_DOT.green],
    ['merging', TONE_DOT.green],
    ['needs_input', TONE_DOT.red],
    ['waiting', TONE_DOT.yellow],
    ['finished', TONE_DOT.violet],
    ['starting', TONE_DOT.blue],
    ['building', TONE_DOT.blue],
    ['killing', TONE_DOT.redSoft],
    ['pending', TONE_DOT.neutral],
    ['stopped', TONE_DOT.neutral],
  ])('agent status %s → %s', (status, expected) => {
    expect(agentDotClass(agent(status, 'created'))).toBe(expected)
  })

  it('distinguishes the stronger needs_input red from the softer killing red', () => {
    expect(agentDotClass(agent('needs_input'))).toBe('bg-red-500')
    expect(agentDotClass(agent('killing'))).toBe('bg-red-400')
  })

  it('falls back to the session dot for badge-only statuses (deploying/ended/exited)', () => {
    expect(agentDotClass(agent('deploying', 'running'))).toBe(TONE_DOT.green)
    expect(agentDotClass(agent('ended', 'exited'))).toBe(TONE_DOT.redSoft)
    expect(agentDotClass(agent('exited', 'created'))).toBe(TONE_DOT.blue)
  })

  it('falls back to the session dot when no agent status is reported', () => {
    expect(agentDotClass(agent(undefined, 'running'))).toBe(TONE_DOT.green)
    expect(agentDotClass(agent(undefined, ''))).toBe(TONE_DOT.neutral)
  })

  it('falls back to the session dot for an unrecognised agent status', () => {
    expect(agentDotClass(agent('whatever', 'running'))).toBe(TONE_DOT.green)
  })
})

describe('agentStatusBadge (agent status → label + chip)', () => {
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

describe('archivedEndStateBadge (end state → label + chip)', () => {
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

describe('dot/badge agree on the shared tone', () => {
  // The point of the consolidation: a status' dot and its badge are two views of
  // the same tone. For the statuses that carry both, the dot color is exactly the
  // tone's dot and the badge is exactly the tone's badge — they can't drift apart.
  it.each([
    ['running', 'green'],
    ['merging', 'green'],
    ['needs_input', 'red'],
    ['waiting', 'yellow'],
    ['finished', 'violet'],
    ['starting', 'blue'],
    ['building', 'blue'],
  ] as const)('%s shares the %s tone across dot and badge', (status, tone) => {
    expect(agentDotClass(agent(status))).toBe(TONE_DOT[tone])
    expect(agentStatusBadge(status).className).toBe(TONE_BADGE[tone])
  })
})
