import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpawnForm } from './SpawnForm'
import { api } from '../stores/apiClient'
import type { AgentResponse } from '../api'

vi.mock('../lib/composerPrefs', async (importActual) => ({
  ...await importActual<typeof import('../lib/composerPrefs')>(), richTextEditorEnabled: false,
}))
vi.mock('../api/uploads', async (importActual) => ({
  ...await importActual<typeof import('../api/uploads')>(),
  uploadFile: vi.fn(async (_project: string, file: File) => ({ path: `/abs/${file.name}`, filename: file.name })),
}))
vi.mock('../lib/branchCache', () => ({ peekBranches: () => null, fetchBranches: async () => ({ branches: [], current: '', default: '' }) }))
beforeEach(() => { localStorage.clear(); URL.createObjectURL = vi.fn(() => 'blob:source-file') })
afterEach(() => vi.restoreAllMocks())

it('submits literal Markdown and uploaded files from the native source composer', async () => {
  const spawn = vi.spyOn(api.default, 'spawnAgent').mockResolvedValue({ id: 'new-head' } as AgentResponse)
  const { container } = render(<SpawnForm projectId="source-project" compact />)
  const composer = await screen.findByRole('textbox', { name: 'Describe a task' })
  expect(composer.tagName).toBe('TEXTAREA')
  fireEvent.change(composer, { target: { value: '**keep** `source`' } })
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['notes'], 'note.txt')] } })
  await screen.findByLabelText('Remove note.txt')
  await waitFor(() => expect(container.querySelector('button[type=submit]')).not.toBeDisabled())
  fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(spawn).toHaveBeenCalledWith('source-project', expect.objectContaining({ prompt: '**keep** `source`\n\n/abs/note.txt' })))
  await waitFor(() => expect(composer).toHaveValue(''))
})

it('undoes and redoes source attachments without requiring an editor document', async () => {
  const { container } = render(<SpawnForm projectId="source-undo" compact />)
  const composer = await screen.findByRole('textbox', { name: 'Describe a task' })
  fireEvent.change(composer, { target: { value: 'draft' } })
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['notes'], 'note.txt')] } })
  await screen.findByLabelText('Remove note.txt')
  fireEvent.keyDown(composer, { key: 'z', ctrlKey: true })
  await waitFor(() => expect(screen.queryByLabelText('Remove note.txt')).toBeNull())
  expect(composer).toHaveValue('draft')
  fireEvent.keyDown(composer, { key: 'y', ctrlKey: true })
  await screen.findByLabelText('Remove note.txt')
})

it('inserts native desktop paste markers at the source caret', async () => {
  render(<SpawnForm projectId="source-desktop" compact />)
  const composer = await screen.findByRole('textbox', { name: 'Describe a task' }) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'before after' } })
  composer.focus()
  composer.setSelectionRange(7, 7)
  act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', { detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' } })))
  await screen.findByLabelText('Remove image1.png')
  await waitFor(() => expect(composer.value).toBe('before [image1.png]after'))
})
