import { describe, expect, it } from 'vitest'
import { formatBashForDisplay, unwrapBashLoginCommand } from './bashFormat'

describe('Codex bash display', () => {
  it('unwraps a login-shell command and formats its chains', () => {
    expect(formatBashForDisplay('/usr/bin/bash -lc "rg -n \\"queue\\" web/src && git status; echo done"')).toBe(
      'rg -n "queue" web/src &&\ngit status;\necho done',
    )
  })

  it('prepends a non-default working directory', () => {
    expect(formatBashForDisplay("bash -lc 'pwd'", 'packages/chat ui')).toBe("cd 'packages/chat ui' &&\npwd")
  })

  it('leaves ambiguous launchers untouched', () => {
    expect(unwrapBashLoginCommand('bash -lc echo hi')).toBe('bash -lc echo hi')
  })

	it('renders a bare command as the same shell script', () => {
		expect(formatBashForDisplay('echo 123123')).toBe('echo 123123')
		expect(formatBashForDisplay('/usr/bin/bash -lc "echo 123123"')).toBe('echo 123123')
	})
})
