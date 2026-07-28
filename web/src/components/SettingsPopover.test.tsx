import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SettingsPopover } from './SettingsPopover'

afterEach(cleanup)

describe('SettingsPopover', () => {
  // Regression: the trigger used to be a bare <button>, which defaults to
  // type="submit". SpawnForm renders this cog inside its <form>, so opening the
  // spawn options submitted the form and spawned a head.
  it('does not submit a surrounding form when opened', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <SettingsPopover label="Spawn options">
          <span>panel body</span>
        </SettingsPopover>
      </form>,
    )

    fireEvent.click(screen.getByLabelText('Spawn options'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('panel body')).toBeTruthy()
  })
})
