import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CacheListEditor, PathListEditor, PortListEditor } from './ConfigForm'

describe('settings list editors', () => {
  it('inserts a blank path row after the current row on Enter', () => {
    const onChange = vi.fn()
    render(<PathListEditor paths={['registry.npmjs.org', 'github.com']} onChange={onChange} placeholder="Host" />)

    fireEvent.keyDown(screen.getByDisplayValue('registry.npmjs.org'), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith(['registry.npmjs.org', '', 'github.com'])
  })

  it('inserts a blank port row after the current row on Enter', () => {
    const onChange = vi.fn()
    render(<PortListEditor ports={[3000, 8080]} onChange={onChange} placeholder="Port" />)

    fireEvent.keyDown(screen.getByDisplayValue('3000'), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith([3000, 0, 8080])
  })

  it('edits cache targets and changes cache kinds', () => {
    const onChange = vi.fn()
    render(<CacheListEditor caches={{ go_build: { env: 'GOCACHE' } }} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Cache target for go_build'), { target: { value: 'GO_CACHE' } })
    expect(onChange).toHaveBeenLastCalledWith({ go_build: { env: 'GO_CACHE' } })

    fireEvent.change(screen.getByLabelText('Cache type for go_build'), { target: { value: 'path' } })
    expect(onChange).toHaveBeenLastCalledWith({ go_build: { path: 'GOCACHE' } })
  })

  it('adds and removes cache rows', () => {
    const onChange = vi.fn()
    render(<CacheListEditor caches={{ go_build: { env: 'GOCACHE' } }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add cache' }))
    expect(onChange).toHaveBeenLastCalledWith({ go_build: { env: 'GOCACHE' }, cache_1: { env: '' } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove cache go_build' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})
