import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '../api'
import { ReviewThreadCard, type ReviewThreadActions } from './ReviewThreadCard'

afterEach(cleanup)

function actions(applySuggestion = vi.fn(async () => {})): ReviewThreadActions {
  return {
    provider: 'github',
    reply: vi.fn(async () => {}),
    replyLocal: vi.fn(async () => {}),
    commentOnLine: vi.fn(async () => {}),
    resolveWithAgent: vi.fn(async () => {}),
    applySuggestion,
    suggestionsInBatch: new Set(),
    toggleSuggestionBatch: vi.fn(),
    draft: { load: () => '', save: () => {}, clear: () => {} },
  }
}

function thread(applied: boolean): ReviewThread {
  return {
    id: 'thread-1', path: 'a.ts', line: 4,
    notes: [{
      id: 'note-1', number: 7, author: 'reviewer', origin: 'forge',
      body: 'Use the shared helper.\n\n```suggestion\nsharedValue()\n```',
      suggestion: { start_line: 4, end_line: 4, replacement: 'sharedValue()', applied },
    }],
  }
}

describe('ReviewThreadCard suggestions', () => {
  it('applies one suggestion by its comment number', async () => {
    const apply = vi.fn(async () => {})
    render(<ReviewThreadCard thread={thread(false)} actions={actions(apply)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }))

    await waitFor(() => expect(apply).toHaveBeenCalledWith(7))
  })

  it('adds a suggestion to an explicit batch', () => {
    const base = actions()
    render(<ReviewThreadCard thread={thread(false)} actions={base} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add to batch' }))

    expect(base.toggleSuggestionBatch).toHaveBeenCalledWith(7)
  })

  it('shows an applied suggestion without another apply control', () => {
    render(<ReviewThreadCard thread={thread(true)} actions={actions()} />)

    expect(screen.getByText('Applied')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply suggestion' })).not.toBeInTheDocument()
  })
})
