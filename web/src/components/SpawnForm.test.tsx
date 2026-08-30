import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
