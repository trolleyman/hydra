import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProjectDropdown } from './__root'
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

function renderDropdown() {
  return render(
    <ProjectDropdown
      projects={projects}
      selectedId={null}
      onSelect={() => {}}
      onDeselect={() => {}}
      onAddProject={async () => {}}
      onRemoveProject={async () => {}}
      keyboardIndex={null}
    />,
  )
}

describe('ProjectDropdown — Escape to close', () => {
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
