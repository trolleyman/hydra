import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TrustProjectModal } from './TrustProjectModal'
import type { ProjectInfo } from '../api'

// The modal reads .hydra/config.toml on mount; stub the client so the effect
// resolves without a network call. We don't assert on the config body here —
// the focus is the Escape-to-cancel keyboard handling.
vi.mock('../stores/apiClient', () => ({
  api: {
    default: {
      getProjectConfigToml: vi.fn().mockResolvedValue({ content: '', exists: false }),
    },
  },
}))

afterEach(cleanup)

const project: ProjectInfo = { id: 'a', name: 'Alpha', path: '/tmp/alpha' } as ProjectInfo

function renderModal(onCancel: () => void) {
  return render(<TrustProjectModal project={project} onTrusted={() => {}} onCancel={onCancel} />)
}

describe('TrustProjectModal — Escape to cancel', () => {
  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn()
    renderModal(onCancel)

    expect(screen.getByText('Trust this project?')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onCancel = vi.fn()
    renderModal(onCancel)

    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('stops cancelling Escape once unmounted', () => {
    const onCancel = vi.fn()
    const { unmount } = renderModal(onCancel)
    unmount()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })
})
