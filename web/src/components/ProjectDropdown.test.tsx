import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProjectDropdown } from './ProjectDropdown'
import type { ProjectInfo } from '../api'

// Component test for the project switcher's keyboard dismissal (Esc closes the
// open dropdown, mirroring the existing outside-click behaviour). The native
// folder picker's availability probe swallows its own errors and resolves false,
// and ServiceHealthWarning no-ops for a null project id, so no mocking is needed
// beyond the no-op callbacks.
afterEach(cleanup)

const projects: ProjectInfo[] = [
  { id: 'a', name: 'Alpha', path: '/tmp/alpha' } as ProjectInfo,
  { id: 'b', name: 'Bravo', path: '/tmp/bravo' } as ProjectInfo,
]

function renderDropdown(list: ProjectInfo[] = projects, selectedId: string | null = null) {
  return render(
    <ProjectDropdown
      projects={list}
      selectedId={selectedId}
      onSelect={() => {}}
      onDeselect={() => {}}
      onAddProject={async () => {}}
    />,
  )
}

describe('ProjectDropdown - Escape to close', () => {
  it('closes the open dropdown when Escape is pressed', () => {
    renderDropdown()

    // Closed initially: the project rows are not rendered.
    expect(screen.queryByText('Alpha')).toBeNull()

    // Open via the folder button.
    fireEvent.click(screen.getByLabelText('Select project'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Bravo')).toBeInTheDocument()

    // Escape dismisses it.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Alpha')).toBeNull()
  })

  it('ignores other keys while open', () => {
    renderDropdown()
    fireEvent.click(screen.getByLabelText('Select project'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })
})

// A hidden project is out of the list everywhere except the two places it has to
// stay reachable: edit mode (where it is hidden and shown again) and the picker
// of the project you currently have open.
describe('ProjectDropdown - hidden projects', () => {
  const withHidden: ProjectInfo[] = [
    { id: 'a', name: 'Alpha', path: '/tmp/alpha' } as ProjectInfo,
    { id: 'b', name: 'Bravo', path: '/tmp/bravo', hidden: true } as ProjectInfo,
  ]

  it('leaves a hidden project out of the list', () => {
    renderDropdown(withHidden)
    fireEvent.click(screen.getByLabelText('Select project'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Bravo')).toBeNull()
  })

  it('shows a hidden project while it is the selected one', () => {
    renderDropdown(withHidden, 'b')
    // Two matches once open: the trigger button's label and the row itself. The
    // row is the point - a picker whose own project is missing reads as broken.
    expect(screen.getAllByText('Bravo')).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Select project'))
    expect(screen.getAllByText('Bravo')).toHaveLength(2)
  })

  it('lists every project - and offers the visibility toggle - in edit mode', () => {
    renderDropdown(withHidden)
    fireEvent.click(screen.getByLabelText('Select project'))
    fireEvent.click(screen.getByText('Edit list'))

    expect(screen.getByText('Bravo')).toBeInTheDocument()
    // The label states the action, so a hidden row offers "Show" and a visible
    // one "Hide".
    expect(screen.getByLabelText('Show Bravo in the project list')).toBeInTheDocument()
    expect(screen.getByLabelText('Hide Alpha from the project list')).toBeInTheDocument()
  })
})
