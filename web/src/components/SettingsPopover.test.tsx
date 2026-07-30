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

  // The reset button is the panel's only chrome, and it sits inside the same
  // <form> as the cog - so it needs the explicit type="button" too, or resetting
  // the spawn options would spawn a head.
  it('renders a reset button that does not submit a surrounding form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const onReset = vi.fn()
    render(
      <form onSubmit={onSubmit}>
        <SettingsPopover label="Spawn options" onReset={onReset} resetLabel="Reset options">
          <span>panel body</span>
        </SettingsPopover>
      </form>,
    )

    fireEvent.click(screen.getByLabelText('Spawn options'))
    fireEvent.click(screen.getByLabelText('Reset options'))

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // Nothing to reset -> no button, so a panel that is entirely on its defaults
  // carries no dead control.
  it('omits the reset button when no handler is given', () => {
    render(
      <SettingsPopover label="Spawn options">
        <span>panel body</span>
      </SettingsPopover>,
    )

    fireEvent.click(screen.getByLabelText('Spawn options'))

    expect(screen.queryByLabelText('Reset to defaults')).toBeNull()
  })

  // `active` is what makes a non-default setting visible with the panel CLOSED:
  // the trigger keeps the blue "on" treatment and wears a dot.
  it('marks the closed trigger when a non-default option is set', () => {
    const { rerender } = render(
      <SettingsPopover label="Spawn options">
        <span>panel body</span>
      </SettingsPopover>,
    )
    const plain = screen.getByLabelText('Spawn options')
    expect(plain.className).not.toContain('border-blue-300')
    expect(plain.querySelector('span.rounded-full')).toBeNull()

    rerender(
      <SettingsPopover label="Spawn options" active>
        <span>panel body</span>
      </SettingsPopover>,
    )
    const marked = screen.getByLabelText('Spawn options')
    expect(marked.className).toContain('border-blue-300')
    expect(marked.querySelector('span.rounded-full')).toBeTruthy()
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
