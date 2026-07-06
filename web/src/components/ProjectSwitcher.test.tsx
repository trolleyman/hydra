import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ProjectSwitcher } from './ProjectSwitcher'
import type { SwitcherState } from '../lib/useGlobalShortcuts'
import type { ProjectInfo } from '../api'

// Component test for the Ctrl+` project switcher's per-project agent tally: the
// same ProjectAgentCounts chips the sidebar dropdown shows should render for each
// row, with the highlighted (active) row's numbers styled for its blue fill.
afterEach(cleanup)

// jsdom doesn't implement scrollIntoView (the switcher calls it to keep the
// active row visible), so stub it out.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

const items: ProjectInfo[] = [
  { id: 'a', name: 'Alpha', path: '/tmp/alpha', agent_count: 2, running_count: 2 } as ProjectInfo,
  { id: 'b', name: 'Bravo', path: '/tmp/bravo', agent_count: 3, waiting_count: 3, unread_count: 1 } as ProjectInfo,
]

function renderSwitcher(state: SwitcherState) {
  return render(<ProjectSwitcher state={state} />)
}

describe('ProjectSwitcher - agent tally', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ProjectSwitcher state={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows each project row with its agent tally summary', () => {
    renderSwitcher({ items, index: 0 })
    // The tally exposes a spoken summary via aria-label/title.
    expect(screen.getByTitle('2 agents - 2 running')).toBeInTheDocument()
    expect(screen.getByTitle('3 agents - 3 waiting')).toBeInTheDocument()
  })

  it('shows the notification dot next to the name, not in the tally', () => {
    renderSwitcher({ items, index: 0 })
    // Bravo has 1 unread agent: a blue dot labelled with the count. It sits in
    // the same flex row as the project name (its direct parent contains the
    // name text), not inside the trailing tally.
    const dot = screen.getByTitle('1 unread update')
    expect(dot.className).toContain('bg-sky-500')
    expect(dot.parentElement?.textContent).toBe('Bravo')
    // Alpha has nothing unread and nothing blocked: Bravo's is the only dot.
    expect(screen.queryAllByTitle(/needs your input|unread update/)).toHaveLength(1)
  })

  it('escalates the dot to red when an agent needs input', () => {
    const blocked = [
      { id: 'c', name: 'Charlie', path: '/tmp/charlie', agent_count: 1, needs_input_count: 1, unread_count: 1 } as ProjectInfo,
    ]
    renderSwitcher({ items: blocked, index: 0 })
    // needs_input beats unread: the dot goes red (same escalation as the
    // top-bar folder-button dot).
    expect(screen.getByTitle('1 agent needs your input').className).toContain('bg-red-500')
  })

  it('styles only the highlighted row for the accent background (white numbers)', () => {
    renderSwitcher({ items, index: 0 })
    // Active row (Alpha, index 0): its "2" running number goes white on the blue fill.
    expect(screen.getByText('2').className).toContain('text-white')
    // Inactive row (Bravo): its "3" waiting number keeps the status color, not white.
    expect(screen.getByText('3').className).not.toContain('text-white')
  })
})
