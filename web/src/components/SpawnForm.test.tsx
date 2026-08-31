import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    ['compact', true, 'Describe a task...'],
    ['full-page', false, 'Describe what you need...'],
  ])('accepts a native desktop clipboard image in the %s composer', async (_name, compact, placeholder) => {
    render(<SpawnForm projectId="proj" compact={compact} />)
    const textarea = await screen.findByPlaceholderText(placeholder) as HTMLTextAreaElement
    textarea.focus()

    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    await screen.findByLabelText('Remove image1.png')
    expect(textarea.value).toBe('[image1.png]')
    expect(textarea).toHaveAttribute('data-desktop-image-paste')
  })

  it('uses the selected project restored after the spawn form mounted', async () => {
    useProjectStore.setState({ selectedProjectId: null })
    render(<SpawnForm projectId={null} />)
    const textarea = await screen.findByPlaceholderText('Describe what you need...') as HTMLTextAreaElement
    textarea.focus()

    // Reproduce the boot window from the desktop app: the long-lived native
    // paste listener was registered while the prop was null, then project state
    // restored the visible selection before the paste arrived.
    useProjectStore.setState({ selectedProjectId: 'proj' })
    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    await screen.findByLabelText('Remove image1.png')
    expect(uploadFile).toHaveBeenCalledWith('proj', expect.objectContaining({ name: 'image1.png' }))
  })

  it('numbers back-to-back desktop images before React commits the first one', async () => {
    render(<SpawnForm projectId="proj-rapid" />)
    const textarea = await screen.findByPlaceholderText('Describe what you need...') as HTMLTextAreaElement
    textarea.focus()

    act(() => {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
          detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
        }))
      }
    })

    await screen.findByLabelText('Remove image1.png')
    expect(screen.getByLabelText('Remove image2.png')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove image3.png')).toBeInTheDocument()
  })

  it('ignores native image paste while no project is selected', async () => {
    useProjectStore.setState({ selectedProjectId: null })
    render(<SpawnForm projectId={null} />)
    const textarea = await screen.findByPlaceholderText('Describe what you need...') as HTMLTextAreaElement
    textarea.focus()

    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    expect(uploadFile).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Remove image1.png')).not.toBeInTheDocument()
  })
})
