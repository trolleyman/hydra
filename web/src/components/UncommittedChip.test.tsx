import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { UncommittedChip } from './UncommittedChip'
import type { RepositoryUncommittedChanges } from '../api'

// Component test for the sidebar's uncommitted-changes warning: the chip only
// shows for a dirty tree, its popover lists the dirty paths with a prefilled
// message, and Commit sends exactly the shown paths (closing on success).
afterEach(cleanup)

const oneFile: RepositoryUncommittedChanges = {
  total: 1,
  files: [{ path: '.hydra/config.toml', status: 'modified' }],
}

function renderChip(
  uncommitted: RepositoryUncommittedChanges,
  onCommit: (message: string, paths: string[]) => Promise<boolean> = async () => true,
) {
  return render(<UncommittedChip uncommitted={uncommitted} committing={false} onCommit={onCommit} />)
}

describe('UncommittedChip', () => {
  it('renders nothing when the tree is clean', () => {
    renderChip({ total: 0, files: [] })
    expect(screen.queryByTestId('uncommitted-chip')).toBeNull()
  })

  it('opens a popover listing the files, with a message named after a lone file', () => {
    renderChip(oneFile)

    // Closed initially: the popover content is not rendered.
    expect(screen.queryByPlaceholderText('Commit message')).toBeNull()

    fireEvent.click(screen.getByTestId('uncommitted-chip'))
    expect(screen.getByText('.hydra/config.toml')).toBeInTheDocument()
    expect(screen.getByText('modified')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Commit message')).toHaveValue('Update .hydra/config.toml')
  })

  it('notes paths beyond the display cap and counts only the shown ones', () => {
    renderChip({
      total: 25,
      files: [
        { path: 'a.txt', status: 'modified' },
        { path: 'b.txt', status: 'untracked' },
      ],
    })
    fireEvent.click(screen.getByTestId('uncommitted-chip'))
    expect(screen.getByPlaceholderText('Commit message')).toHaveValue('Commit 2 local changes')
    expect(screen.getByText('...and 23 more, not included in this commit')).toBeInTheDocument()
  })

  it('commits the shown paths with the edited message and closes on success', async () => {
    const onCommit = vi.fn(async () => true)
    renderChip(oneFile, onCommit)

    fireEvent.click(screen.getByTestId('uncommitted-chip'))
    const input = screen.getByPlaceholderText('Commit message')
    fireEvent.change(input, { target: { value: 'My tuned message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    expect(onCommit).toHaveBeenCalledWith('My tuned message', ['.hydra/config.toml'])
    await waitFor(() => expect(screen.queryByPlaceholderText('Commit message')).toBeNull())
  })

  it('stays open when the commit fails, so the user can retry', async () => {
    const onCommit = vi.fn(async () => false)
    renderChip(oneFile, onCommit)

    fireEvent.click(screen.getByTestId('uncommitted-chip'))
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(onCommit).toHaveBeenCalled())
    expect(screen.getByPlaceholderText('Commit message')).toBeInTheDocument()
  })

  it('commits on Ctrl+Enter and closes on Escape', async () => {
    const onCommit = vi.fn(async () => true)
    renderChip(oneFile, onCommit)

    fireEvent.click(screen.getByTestId('uncommitted-chip'))
    fireEvent.keyDown(screen.getByPlaceholderText('Commit message'), { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledWith('Update .hydra/config.toml', ['.hydra/config.toml'])
    await waitFor(() => expect(screen.queryByPlaceholderText('Commit message')).toBeNull())

    // Reopen, then Escape dismisses without committing again.
    fireEvent.click(screen.getByTestId('uncommitted-chip'))
    expect(screen.getByPlaceholderText('Commit message')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Commit message')).toBeNull()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})
