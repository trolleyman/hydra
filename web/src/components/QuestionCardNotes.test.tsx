import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuestionCard, deriveAnswered } from './AgentChat'

// An answer to an AskUserQuestion can carry a free-text note ALONGSIDE the
// picked option ("Postgres, but keep the schema in one file"), which is a
// different thing from the "Other" row replacing the option. The CLI takes
// those as the tool's own `annotations[question].notes` and renders them into
// the tool result next to the answer they qualify, so the card has to put them
// in `annotations` rather than folding them into the answer string.

const SPECS = [
  {
    question: 'Which database?',
    header: 'Storage',
    multiSelect: false,
    options: [{ label: 'Postgres', description: 'Relational.' }, { label: 'SQLite' }],
  },
]

describe('QuestionCard notes', () => {
  it('sends a note alongside the picked option, in annotations', () => {
    const onSubmit = vi.fn(() => true)
    render(<QuestionCard specs={SPECS} disabled={false} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByText('Postgres'))
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    fireEvent.change(screen.getByLabelText('Note to go with your answer'), {
      target: { value: 'but keep the schema in one file' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith(
      { 'Which database?': 'Postgres' },
      { 'Which database?': { notes: 'but keep the schema in one file' } },
    )
  })

  it('leaves annotations empty when no note was written', () => {
    const onSubmit = vi.fn(() => true)
    render(<QuestionCard specs={SPECS} disabled={false} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByText('SQLite'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ 'Which database?': 'SQLite' }, {})
  })

  // The CLI records a note with no pick as `"<q>"=(no option selected) notes: ...`,
  // so gating Submit on an option would refuse to send something it handles.
  it('accepts a note on its own as an answer', () => {
    const onSubmit = vi.fn(() => true)
    render(<QuestionCard specs={SPECS} disabled={false} onSubmit={onSubmit} />)

    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    fireEvent.change(screen.getByLabelText('Note to go with your answer'), {
      target: { value: 'neither - use the file store' },
    })
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledWith(
      { 'Which database?': '' },
      { 'Which database?': { notes: 'neither - use the file store' } },
    )
  })
})

// A note reads as a caveat on the choice it qualifies, so it sits directly
// under that row rather than at the foot of the card. The "Add a note" link is
// a question-level affordance and stays at the foot until there is a note.
describe('QuestionCard note placement', () => {
  const rows = () => Array.from(document.querySelector('[data-question-rows]')!.children)
  const noteIndex = () => rows().findIndex((r) => r.querySelector('textarea[aria-label="Note to go with your answer"]'))
  const optionIndex = (label: string) => rows().findIndex((r) => r.textContent?.startsWith(label))

  it('moves the note under the option you pick, and back when you unpick', () => {
    render(<QuestionCard specs={SPECS} disabled={false} onSubmit={() => true} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))

    // Nothing picked yet: the note is the last row.
    expect(noteIndex()).toBe(rows().length - 1)

    fireEvent.click(screen.getByText('Postgres'))
    expect(noteIndex()).toBe(optionIndex('Postgres') + 1)

    fireEvent.click(screen.getByText('SQLite'))
    expect(noteIndex()).toBe(optionIndex('SQLite') + 1)

    // "Other" is the last row, so a note qualifying it stays at the foot.
    fireEvent.focus(screen.getByPlaceholderText('Other...'))
    expect(noteIndex()).toBe(rows().length - 1)
  })

  it('keeps the collapsed link at the foot even with an option picked', () => {
    render(<QuestionCard specs={SPECS} disabled={false} onSubmit={() => true} />)
    fireEvent.click(screen.getByText('Postgres'))
    const link = rows().findIndex((r) => r.textContent === 'Add a note')
    expect(link).toBe(rows().length - 1)
  })
})

// On a resume the card's local state is gone and only the tool_result text
// survives, so the note has to be recoverable from it - including knowing where
// it stops, since a note is the last thing in its entry and the CLI wraps the
// whole list in a sentence.
describe('deriveAnswered with notes', () => {
  const TWO = [
    { question: 'Which database?', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { question: 'Which extras?', multiSelect: true, options: [{ label: 'Schema validation' }, { label: 'Hot reload' }] },
  ]

  it('recovers a note per question and stops at the closing sentence', () => {
    const { selected, notes } = deriveAnswered(
      TWO,
      'The user answered: "Which database?"="Postgres" notes: but keep the schema in one file, ' +
        '"Which extras?"="Schema validation, Hot reload" notes: only if it is cheap. ' +
        'Read the answers carefully - they may request clarification, changes, or that you not proceed - and follow what they actually say.',
    )
    expect([...selected[0]]).toEqual([0])
    expect([...selected[1]]).toEqual([0, 1])
    expect(notes[0]).toBe('but keep the schema in one file')
    expect(notes[1]).toBe('only if it is cheap')
  })

  it('recovers a note left on a question with no option picked', () => {
    const { selected, other, notes } = deriveAnswered(
      TWO,
      'The user answered: "Which database?"=(no option selected) notes: neither - use the file store, ' +
        '"Which extras?"="Hot reload". Read the answers carefully - and follow what they actually say.',
    )
    expect(selected[0].size).toBe(0)
    expect(other[0]).toBe('')
    expect(notes[0]).toBe('neither - use the file store')
    expect([...selected[1]]).toEqual([1])
    expect(notes[1]).toBe('')
  })

  // The note-less result shape (and its cheerier closing sentence) still parses.
  it('leaves notes empty for a plain answer', () => {
    const { selected, notes } = deriveAnswered(
      TWO,
      'Your questions have been answered: "Which database?"="SQLite", "Which extras?"="Hot reload". ' +
        'You can now continue with these answers in mind.',
    )
    expect([...selected[0]]).toEqual([1])
    expect(notes).toEqual(['', ''])
  })
})
