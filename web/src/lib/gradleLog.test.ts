import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi'
import { colorizeGradleLogLine } from './gradleLog'

describe('colorizeGradleLogLine', () => {
  it('colours task paths and their dispositions without changing the text', () => {
    const source = '> Task :app:compileDebugKotlin UP-TO-DATE'
    const coloured = colorizeGradleLogLine(source)

    expect(coloured).toContain('\x1b[34m:app:compileDebugKotlin')
    expect(coloured).toContain('\x1b[2mUP-TO-DATE')
    expect(stripAnsi(coloured ?? '')).toBe(source)
  })

  it('colours Gradle outcomes and task totals', () => {
    expect(colorizeGradleLogLine('BUILD SUCCESSFUL in 3m 21s')).toContain('\x1b[32m')
    expect(colorizeGradleLogLine('BUILD FAILED in 12s')).toContain('\x1b[31m')
    expect(colorizeGradleLogLine('36 actionable tasks: 4 executed, 32 up-to-date')).toContain('\x1b[2m')
  })

  it('leaves ordinary build output alone', () => {
    expect(colorizeGradleLogLine('Running 24 tests')).toBeNull()
    expect(colorizeGradleLogLine('> an unrelated indented message')).toBeNull()
  })
})
