import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TrustProjectModal } from './TrustProjectModal'

// The modal previews .hydra/config.toml on mount; stub the client so the effect
// resolves without a network call. We don't assert on the config body here -
// the focus is the Escape-to-cancel keyboard handling.
vi.mock('../stores/apiClient', () => ({
  api: {
    default: {
      previewConfigToml: vi.fn().mockResolvedValue({ content: '', exists: false }),
    },
  },
}))

afterEach(cleanup)

function renderModal(onCancel: () => void) {
  return render(
    <TrustProjectModal name="Alpha" path="/tmp/alpha" onTrusted={() => {}} onCancel={onCancel} />,
  )
}

describe('TrustProjectModal - Escape to cancel', () => {
  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn()
    renderModal(onCancel)

    expect(screen.getByText('Trust this project?')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('uses the modal layer above portalled project menus', () => {
    const { container } = renderModal(() => {})
    expect(container.firstChild).toHaveClass('z-[10000]')
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
