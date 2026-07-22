import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { isValidElement, type ReactElement } from 'react'
import { useAgentNotifications } from './useAgentNotifications'
import { useAgentStore } from '../stores/agentStore'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore, type Toast } from '../stores/toastStore'
import type { AgentTransitionSpec } from './agentToast'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'

// react-router's useNavigate touches a live router context we don't set up here;
// the transition-toast path only needs it to exist, so stub it to a no-op.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

// Spy on the OS-notification helpers. fireNotification is inert in these tests
// (pageActive=true keeps it from being called anyway); dismissNotification is the
// retraction we assert on when a needs_input/unread state clears.
vi.mock('./notifyPrefs', () => ({
  fireNotification: vi.fn(),
  dismissNotification: vi.fn(),
}))
import { dismissNotification, fireNotification } from './notifyPrefs'

// Resolving a real icon needs a canvas; the hook only forwards whatever URL the
// cache holds, so stub it to a fixed one and assert the hand-off.
vi.mock('./projectIconUrl', () => ({
  ensureProjectIconUrl: vi.fn(() => Promise.resolve('icon-url')),
  projectIconUrl: vi.fn(() => 'icon-url'),
}))

const PROJECT = 'proj-1'

function makeAgent(id: string, status: AgentStatus, unread = false): AgentResponse {
  return {
    id,
    project_path: '/proj',
    session_pid: 0,
    session_status: 'running',
    agent_type: 'claude',
    pre_prompt: '',
    prompt: '',
    base_branch: 'main',
    has_unread_changes: unread,
    agent_status: { status, timestamp: '2026-01-01T00:00:00Z' },
  }
}

// Seed the live agent list for the current project without the optimistic-override
// machinery in setAgents, so a status is exactly what we set.
function seedAgents(agents: AgentResponse[]) {
  act(() => {
    useAgentStore.setState({ agents, agentsProjectId: PROJECT })
  })
}

// Agent-transition toasts carry a rich element `message` (the AgentTransitionRow
// from lib/agentToast); plain toasts have a string message. So an element message
// identifies a transition toast, and its props are the AgentTransitionSpec.
const transitionToasts = () =>
  useToastStore.getState().toasts.filter((t) => isValidElement(t.message))
const specOf = (t: Toast) => (t.message as ReactElement<AgentTransitionSpec>).props

beforeEach(() => {
  useToastStore.setState(useToastStore.getInitialState(), true)
  useAgentStore.setState(useAgentStore.getInitialState(), true)
  useProjectStore.setState({ projects: [] })
  vi.mocked(dismissNotification).mockClear()
  vi.mocked(fireNotification).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Render the hook, seed a first-sighting (which never toasts), then transition the
// agent's status and let the effect re-run. `selectedAgentId` is what the branch
// page has open. pageActive=true keeps OS notifications out of the picture.
function runTransition(selectedAgentId: string | undefined, to: AgentStatus) {
  seedAgents([makeAgent('a1', AgentStatus.RUNNING)])
  renderHook(() => useAgentNotifications(PROJECT, true, selectedAgentId))
  seedAgents([makeAgent('a1', to)])
}

describe('useAgentNotifications - suppress toasts for the selected branch', () => {
  it('pops a finished transition toast when a different branch is selected', () => {
    runTransition('other-agent', AgentStatus.FINISHED)
    expect(transitionToasts()).toHaveLength(1)
    expect(specOf(transitionToasts()[0]).agentId).toBe('a1')
  })

  it('pops a needs_input transition toast when no branch is selected', () => {
    runTransition(undefined, AgentStatus.NEEDS_INPUT)
    expect(transitionToasts()).toHaveLength(1)
  })

  it('suppresses the finished toast when its own branch is the selected one', () => {
    runTransition('a1', AgentStatus.FINISHED)
    expect(transitionToasts()).toHaveLength(0)
  })

  it('suppresses the needs_input toast when its own branch is the selected one', () => {
    runTransition('a1', AgentStatus.NEEDS_INPUT)
    expect(transitionToasts()).toHaveLength(0)
  })

  it('pops an error transition toast when a different branch is selected', () => {
    runTransition('other-agent', AgentStatus.ERRORED)
    const toasts = transitionToasts()
    expect(toasts).toHaveLength(1)
    expect(specOf(toasts[0]).status).toBe('errored')
    expect(toasts[0].type).toBe('error')
  })

  it('suppresses the error toast when its own branch is the selected one', () => {
    runTransition('a1', AgentStatus.ERRORED)
    expect(transitionToasts()).toHaveLength(0)
  })
})

// Out of tab (pageActive=false) the OS notification leads with "Hydra agent in
// <project>" and carries the agent name as the body - the toast's agent-first
// wording is the in-app case, where the project is already obvious.
describe('useAgentNotifications - OS notification copy', () => {
  // Same as runTransition but backgrounded, which is what lets fireNotification run.
  function runBackgroundTransition(to: AgentStatus, agent?: AgentResponse) {
    seedAgents([makeAgent('a1', AgentStatus.RUNNING)])
    renderHook(() => useAgentNotifications(PROJECT, false, undefined))
    seedAgents([agent ?? makeAgent('a1', to)])
    return vi.mocked(fireNotification).mock.calls[0]?.[0]
  }

  it('titles a finished notification with the project id and bodies it with the agent', () => {
    const opts = runBackgroundTransition(AgentStatus.FINISHED)
    expect(opts?.title).toBe('Hydra agent in proj-1 finished')
    expect(opts?.body).toBe('a1')
  })

  it('titles a needs_input notification with the project id', () => {
    const opts = runBackgroundTransition(AgentStatus.NEEDS_INPUT)
    expect(opts?.title).toBe('Hydra agent in proj-1 needs input')
    expect(opts?.body).toBe('a1')
  })

  it('titles an errored notification with the project id', () => {
    const opts = runBackgroundTransition(AgentStatus.ERRORED)
    expect(opts?.title).toBe('Hydra agent in proj-1 hit an API error')
  })

  it('uses the agent title, not its id, as the body when it has one', () => {
    const titled = { ...makeAgent('a1', AgentStatus.FINISHED), title: 'Fix the parser' }
    const opts = runBackgroundTransition(AgentStatus.FINISHED, titled)
    expect(opts?.body).toBe('Fix the parser')
  })

  it("forwards the project's icon so the tray shows which project woke you", () => {
    const opts = runBackgroundTransition(AgentStatus.FINISHED)
    expect(opts?.icon).toBe('icon-url')
  })

  it('stays silent while the tab is in front (the toast covers it)', () => {
    runTransition(undefined, AgentStatus.FINISHED)
    expect(fireNotification).not.toHaveBeenCalled()
  })
})

describe('useAgentNotifications - retract OS notifications when state clears', () => {
  it('dismisses the needs-input notification when the agent leaves needs_input', () => {
    seedAgents([makeAgent('a1', AgentStatus.NEEDS_INPUT)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.RUNNING)])

    expect(dismissNotification).toHaveBeenCalledWith('needs-input:a1')
  })

  it('does not dismiss needs-input while the agent stays blocked', () => {
    seedAgents([makeAgent('a1', AgentStatus.RUNNING)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.NEEDS_INPUT)])

    expect(dismissNotification).not.toHaveBeenCalledWith('needs-input:a1')
  })

  it('dismisses the finished notification when the unread flag is read', () => {
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, true)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, false)])

    expect(dismissNotification).toHaveBeenCalledWith('finished:a1')
  })

  it('does not dismiss finished while the changes stay unread', () => {
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, true)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, true)])

    expect(dismissNotification).not.toHaveBeenCalledWith('finished:a1')
  })
})
