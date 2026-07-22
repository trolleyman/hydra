import { describe, it, expect } from 'vitest'
import { stripAnsi, hasAnsi, ansiToHtml } from './ansi'

const ESC = '\x1b'

describe('stripAnsi', () => {
  it('removes SGR and cursor sequences', () => {
    expect(stripAnsi(`${ESC}[2m${ESC}[35m$${ESC}[0m go`)).toBe('$ go')
    expect(stripAnsi(`a${ESC}[1Kb`)).toBe('ab')
  })
})

describe('hasAnsi', () => {
  it('detects escapes and carriage returns', () => {
    expect(hasAnsi(`x${ESC}[0m`)).toBe(true)
    expect(hasAnsi('a\rb')).toBe(true)
    expect(hasAnsi('plain text')).toBe(false)
  })
})

describe('ansiToHtml', () => {
  it('wraps SGR colour runs in classed spans and escapes html', () => {
    const html = ansiToHtml(`${ESC}[31m<x>${ESC}[0m ok`)
    expect(html).toBe('<span class="ansi-red">&lt;x&gt;</span> ok')
  })

  it('handles bold + dim + reset', () => {
    expect(ansiToHtml(`${ESC}[1mA${ESC}[22mB`)).toBe('<span class="ansi-bold">A</span>B')
  })

  it('renders 256-colour and truecolour as inline styles', () => {
    expect(ansiToHtml(`${ESC}[38;5;196mR`)).toBe('<span style="color:#ff0000">R</span>')
    expect(ansiToHtml(`${ESC}[38;2;10;20;30mT`)).toBe('<span style="color:#0a141e">T</span>')
  })

  it('strips non-SGR CSI sequences but keeps the text', () => {
    expect(ansiToHtml(`a${ESC}[2Kb${ESC}[1;5Hc`)).toBe('abc')
  })

  it('collapses carriage-return progress lines to the final frame', () => {
    expect(ansiToHtml('10%\r50%\r100% done')).toBe('100% done')
  })

  it('preserves ordinary PTY CRLF lines', () => {
    expect(ansiToHtml(`command\r\n${ESC}[?2004l\r\nresult\r\n`)).toBe('command\n\nresult\n')
  })

  it('turns OSC 8 hyperlinks into anchor tags', () => {
    const html = ansiToHtml(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\!`)
    expect(html).toBe('<a href="https://example.com" target="_blank" rel="noreferrer" class="ansi-link">link</a>!')
  })

  it('leaves plain text untouched', () => {
    expect(ansiToHtml('just text')).toBe('just text')
  })
})
