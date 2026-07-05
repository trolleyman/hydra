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
    expect(screen.getByTitle('3 agents - 3 waiting - 1 unread')).toBeInTheDocument()
  })

  it('styles only the highlighted row for the accent background (white numbers)', () => {
    renderSwitcher({ items, index: 0 })
    // Active row (Alpha, index 0): its "2" running number goes white on the blue fill.
    expect(screen.getByText('2').className).toContain('text-white')
    // Inactive row (Bravo): its "3" waiting number keeps the status color, not white.
    expect(screen.getByText('3').className).not.toContain('text-white')
  })
})
