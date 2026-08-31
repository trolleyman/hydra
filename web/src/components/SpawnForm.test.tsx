import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorForMarkdownComposer } from '../lib/rich-editor/mountedEditors'
import { SpawnForm } from './SpawnForm'
import { uploadFile } from '../api/uploads'
import { useProjectStore } from '../stores/projectStore'

vi.mock('../api/uploads', async (importActual) => {
  const actual = await importActual<typeof import('../api/uploads')>()
  return {
    ...actual,
    uploadFile: vi.fn(async (_projectId: string | null, file: File) => ({
      path: `/abs/${file.name}`,
      filename: file.name,
    })),
  }
})

vi.mock('../lib/branchCache', () => ({
  peekBranches: () => null,
  fetchBranches: async () => ({ branches: [], current: '', default: '' }),
}))

describe('SpawnForm desktop attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    URL.createObjectURL = vi.fn(() => 'blob:spawn-image')
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['compact', true, 'Describe a task'],
    ['full-page', false, 'Describe what you need'],
  ])('accepts a native desktop clipboard image in the %s composer', async (_name, compact, label) => {
    render(<SpawnForm projectId="proj" compact={compact} />)
    const composer = await screen.findByRole('textbox', { name: label })
    composer.focus()
    await act(async () => {})

    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    const remove = await screen.findByLabelText('Remove image1.png')
    const currentComposer = await screen.findByRole('textbox', { name: label })
    await waitFor(() => expect(editorForMarkdownComposer(currentComposer)?.getText()).toBe('[image1.png]'))
    expect(remove.closest('[data-composer-attachment]')).toBe(currentComposer.querySelector('[data-composer-attachment]'))
    expect(screen.getAllByLabelText('Remove image1.png')).toHaveLength(1)
    expect(currentComposer).toHaveAttribute('data-desktop-image-paste')
  })

  it('uses the selected project restored after the spawn form mounted', async () => {
    useProjectStore.setState({ selectedProjectId: null })
    render(<SpawnForm projectId={null} />)
    const composer = await screen.findByRole('textbox', { name: 'Describe what you need' })
    composer.focus()
    await act(async () => {})

    // Reproduce the boot window from the desktop app: the long-lived native
    // paste listener was registered while the prop was null, then project state
    // restored the visible selection before the paste arrived.
    useProjectStore.setState({ selectedProjectId: 'proj' })
    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    await screen.findByLabelText('Remove image1.png')
    expect(uploadFile).toHaveBeenCalledWith('proj', expect.objectContaining({ name: 'image1.png' }), expect.any(AbortSignal))
  })

  it('undoes and redoes an attachment as one inline document node', async () => {
    render(<SpawnForm projectId="undo-proj" compact />)
    const composer = await screen.findByRole('textbox', { name: 'Describe a task' })
    composer.focus()
    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    await screen.findByLabelText('Remove image1.png')
    fireEvent.keyDown(composer, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(screen.queryByLabelText('Remove image1.png')).not.toBeInTheDocument())
    fireEvent.keyDown(composer, { key: 'y', ctrlKey: true })
    await screen.findByLabelText('Remove image1.png')
    expect(screen.getAllByLabelText('Remove image1.png')).toHaveLength(1)
  })

  it('ignores native image paste while no project is selected', async () => {
    useProjectStore.setState({ selectedProjectId: null })
    render(<SpawnForm projectId={null} />)
    const composer = await screen.findByRole('textbox', { name: 'Describe what you need' })
    composer.focus()
    await act(async () => {})

    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    expect(uploadFile).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Remove image1.png')).not.toBeInTheDocument()
  })
})
