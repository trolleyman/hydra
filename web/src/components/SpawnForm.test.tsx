import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorForMarkdownComposer } from '../lib/rich-editor/mountedEditors'
import { SpawnForm } from './SpawnForm'

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

    await screen.findByLabelText('Remove image1.png')
    const currentComposer = await screen.findByRole('textbox', { name: label })
    await waitFor(() => expect(editorForMarkdownComposer(currentComposer)?.getText()).toBe('[image1.png]'))
    expect(currentComposer).toHaveAttribute('data-desktop-image-paste')
  })
})
