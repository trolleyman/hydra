import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GENERATED_FILE_GLOBS, useGeneratedFileRulesStore } from '../../lib/generatedFile'
import { GeneratedFilesSection } from './GeneratedFilesSection'

afterEach(() => useGeneratedFileRulesStore.getState().setRules([...DEFAULT_GENERATED_FILE_GLOBS]))

describe('GeneratedFilesSection', () => {
  it('edits, describes, adds, and removes glob rules', () => {
    useGeneratedFileRulesStore.getState().setRules(['*.lock', 'generated/**'])
    render(<GeneratedFilesSection />)

    expect(screen.getByText('Matches filenames in any directory.')).toBeInTheDocument()
    expect(screen.getByText('Matches the complete repository-relative path.')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Auto-generated file glob 1' }), { target: { value: '*.snap' } })
    expect(useGeneratedFileRulesStore.getState().rules[0]).toBe('*.snap')

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(screen.getByRole('textbox', { name: 'Auto-generated file glob 3' })).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Remove auto-generated file glob 2' }))
    expect(useGeneratedFileRulesStore.getState().rules).toEqual(['*.snap', ''])
  })
})
