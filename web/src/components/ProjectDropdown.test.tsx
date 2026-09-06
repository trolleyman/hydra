import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectDropdown } from './ProjectDropdown'
import type { ProjectInfo } from '../api'
import { api } from '../stores/apiClient'

// Component test for the project switcher's keyboard dismissal (Esc closes the
// open dropdown, mirroring the existing outside-click behaviour). The native
// folder picker's availability probe swallows its own errors and resolves false,
// and ServiceHealthWarning no-ops for a null project id, so no mocking is needed
// beyond the no-op callbacks.
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

describe('ProjectDropdown - attention dots', () => {
  const attentionProjects: ProjectInfo[] = [
    { id: 'a', name: 'Alpha', path: '/tmp/alpha', unread_count: 2 } as ProjectInfo,
    { id: 'b', name: 'Bravo', path: '/tmp/bravo', unread_count: 1, needs_input_count: 1 } as ProjectInfo,
  ]

  it('overlays each project icon and gives needs-input priority', () => {
    renderDropdown(attentionProjects, 'a')
    fireEvent.click(screen.getByLabelText('Select project'))

    const unread = screen.getByTitle('2 unread updates')
    const blocked = screen.getByTitle('1 agent needs your input')
    expect(unread.className).toContain('bg-sky-500')
    expect(blocked.className).toContain('bg-red-500')
    for (const dot of [unread, blocked]) {
      expect(dot.className).toContain('-bottom-0.5')
      expect(dot.parentElement?.className).toContain('relative')
    }
  })

  it('puts the aggregate other-project marker on the icon bottom-right', () => {
    renderDropdown(attentionProjects, 'a')
    const dot = screen.getByLabelText('an agent in another project needs your input')
    expect(dot.className).toContain('bg-red-500')
    expect(dot.className).toContain('-bottom-1')
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

describe('ProjectDropdown - editing projects', () => {
  it('only offers add-project actions before the first user project or in edit mode', () => {
    renderDropdown()
    fireEvent.click(screen.getByLabelText('Select project'))

    expect(screen.queryByText('Open folder...')).toBeNull()
    fireEvent.click(screen.getByText('Edit list'))
    expect(screen.getByText('Open folder...')).toBeInTheDocument()
  })

  it('offers add-project actions when only the built-in project exists', () => {
    renderDropdown([
      { id: '_chat', name: 'Just chatting', path: '/tmp/chat', builtin: true } as ProjectInfo,
    ])
    fireEvent.click(screen.getByLabelText('Select project'))

    expect(screen.getByText('Open folder...')).toBeInTheDocument()
  })

  it('renames a user project inline', async () => {
    const rename = vi.spyOn(api.default, 'renameProject').mockResolvedValue(undefined)
    renderDropdown()
    fireEvent.click(screen.getByLabelText('Select project'))
    fireEvent.click(screen.getByText('Edit list'))
    fireEvent.click(screen.getByLabelText('Rename Alpha'))

    const input = screen.getByLabelText('New name for Alpha')
    fireEvent.change(input, { target: { value: '  Apollo  ' } })
    fireEvent.click(screen.getByLabelText('Save name for Alpha'))

    await waitFor(() => expect(rename).toHaveBeenCalledWith('a', { name: 'Apollo' }))
  })

  it('does not offer to rename a built-in project', () => {
    renderDropdown([
      { id: '_chat', name: 'Just chatting', path: '/tmp/chat', builtin: true, hidden: true } as ProjectInfo,
    ])
    fireEvent.click(screen.getByLabelText('Select project'))
    fireEvent.click(screen.getByText('Edit list'))

    expect(screen.queryByLabelText('Rename Just chatting')).toBeNull()
  })

  it('shows path status as an in-field warning instead of shifting text', async () => {
    vi.spyOn(api.default, 'resolvePath').mockResolvedValue({
      path: '/home/test/missing',
      display_path: '~/missing',
      exists: false,
      is_dir: false,
      is_git_repo: false,
    })
    renderDropdown()
    fireEvent.click(screen.getByLabelText('Select project'))
    fireEvent.click(screen.getByText('Edit list'))
    fireEvent.click(screen.getByText('Open folder...'))
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'missing' } })

    const warning = 'Does not exist yet - you will be asked to create it.'
    expect(await screen.findByLabelText(warning)).toBeInTheDocument()
    expect(screen.queryByText(warning)).toBeNull()
  })

  it('puts native browse beside the folder field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ available: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    renderDropdown()
    fireEvent.click(screen.getByLabelText('Select project'))
    fireEvent.click(screen.getByText('Edit list'))
    fireEvent.click(screen.getByText('Open folder...'))

    expect(await screen.findByLabelText('Browse folders')).toBeInTheDocument()
    expect(screen.queryByText('Browse...')).toBeNull()
  })
})
