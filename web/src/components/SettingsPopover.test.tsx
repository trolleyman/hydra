import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SettingsPopover, SettingsSelect } from './SettingsPopover'

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

describe('SettingsSelect', () => {
  // Same hazard as the cog above: this dropdown's trigger and option rows live
  // inside the spawn <form> (it is the git-isolation picker), so a bare <button>
  // would spawn a head on open or on pick.
  it('does not submit a surrounding form when opened or picked from', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const onChange = vi.fn()
    render(
      <form onSubmit={onSubmit}>
        <SettingsSelect
          label="Git isolation"
          value=""
          onChange={onChange}
          options={[
            { id: '', label: 'Default', desc: "Project's policy default." },
            { id: 'off', label: 'Off', desc: 'Full .git access.' },
          ]}
        />
      </form>,
    )

    fireEvent.click(screen.getByLabelText('Git isolation'))
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Off'))
    expect(onChange).toHaveBeenCalledWith('off')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
