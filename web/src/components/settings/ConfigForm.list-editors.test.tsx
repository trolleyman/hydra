import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PathListEditor, PortListEditor } from './ConfigForm'

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
})
