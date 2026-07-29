import { describe, it, expect } from 'vitest'
import { applyFlavourFlag, grepFlavour, regexTokens, takesArgument, type RegexFlavour } from './regexHighlight'

// A pattern's tokens as `text` with a one-letter kind, so a case reads as the
// pattern it is about: `.` literal, `M` meta, `C` character class, `E` the
// backslash of an escaped literal.
function toks(pattern: string, flavour: RegexFlavour): string[] {
  const kinds = { literal: '.', meta: 'M', class: 'C', escape: 'E' }
  return regexTokens(pattern, flavour).map((t) => `${kinds[t.kind]}${t.text}`)
}

// Nothing may be dropped: the caller renders these over the source text.
function roundTrips(pattern: string, flavour: RegexFlavour): boolean {
  return regexTokens(pattern, flavour).map((t) => t.text).join('') === pattern
}

describe('regexTokens', () => {
  it('reads a basic regex, where the backslash MAKES the operator', () => {
    expect(toks('"type": "\\|terminalEvent\\|\\.Append(', 'bre')).toEqual([
      '."type": "', 'M\\|', '.terminalEvent', 'M\\|',
      // `\.` is a full stop and `(` is a bracket - neither does anything here,
      // so only the backslash saying the stop is escaped is marked.
      'E\\', '..Append(',
    ])
  })

  it('reads an extended regex, where the backslash UNMAKES it', () => {
    expect(toks('(foo|bar)+\\.go$', 'ere')).toEqual(['M(', '.foo', 'M|', '.bar', 'M)+', 'E\\', '..go', 'M$'])
    // The same characters, the other way round, in the basic dialect.
    expect(toks('(foo|bar)', 'bre')).toEqual(['.(foo|bar)'])
  })

  it('marks the backslash of an escaped literal, and not the character', () => {
    // The star is what the pattern matches, so it stays the text it is; the
    // backslash is what says so. (A bare `grep` searching for a Go pointer.)
    expect(toks('func (m \\*Manager) Retract', 'bre')).toEqual(['.func (m ', 'E\\', '.*Manager) Retract'])
    // An unescaped one in the same dialect IS a quantifier, so the two read
    // differently rather than both reading as plain text.
    expect(toks('func (m *Manager)', 'bre')).toEqual(['.func (m ', 'M*', '.Manager)'])
  })

  it('picks out character classes and the shorthands for them', () => {
    expect(toks('[A-Z]\\w+', 'pcre')).toEqual(['M[', 'CA-Z', 'M]', 'C\\w', 'M+'])
    expect(toks('[^ab]', 'ere')).toEqual(['M[^', 'Cab', 'M]'])
    // A `]` first in a set is a literal one, and a POSIX class carries its own.
    expect(toks('[]a]', 'ere')).toEqual(['M[', 'C]a', 'M]'])
    expect(toks('[[:alpha:]_]', 'ere')).toEqual(['M[', 'C[:alpha:]_', 'M]'])
    // An unterminated bracket is a bracket, not a set that eats the rest.
    expect(toks('a[b', 'ere')).toEqual(['.a[b'])
  })

  it('takes ^ and $ as anchors only where they anchor', () => {
    expect(toks('^ok', 'bre')).toEqual(['M^', '.ok'])
    expect(toks('exit ^C', 'ere')).toEqual(['.exit ^C'])
    expect(toks('a$', 'ere')).toEqual(['.a', 'M$'])
    expect(toks('costs $5 today', 'ere')).toEqual(['.costs $5 today'])
    // At the edges of a branch, in either dialect's spelling of one. (The
    // alternation and the anchor beside it are one span: same colour, and a
    // span per character would be a lot of spans.)
    expect(toks('^a\\|^b', 'bre')).toEqual(['M^', '.a', 'M\\|^', '.b'])
    expect(toks('a$|b', 'ere')).toEqual(['.a', 'M$|', '.b'])
  })

  it('reads a perl group modifier as part of the group', () => {
    expect(toks('(?:ab)?', 'pcre')).toEqual(['M(?:', '.ab', 'M)?'])
    expect(toks('(?<name>x)', 'pcre')).toEqual(['M(?<name>', '.x', 'M)'])
  })

  it('keeps every character, whatever it is given', () => {
    for (const flavour of ['bre', 'ere', 'pcre'] as const) {
      for (const p of ['', 'a', '\\', '[', '[^', '(?', 'a\\', '**', '$^', '[]', '\\\\|']) {
        expect(roundTrips(p, flavour), `${flavour}: ${JSON.stringify(p)}`).toBe(true)
      }
    }
  })
})

describe('grepFlavour', () => {
  it('knows which searches parse which dialect, and which parse none', () => {
    expect(grepFlavour('grep')).toBe('bre')
    expect(grepFlavour('egrep')).toBe('ere')
    expect(grepFlavour('rg')).toBe('pcre')
    // Fixed strings: there is no regex in it to pick anything out of.
    expect(grepFlavour('fgrep')).toBeNull()
    expect(grepFlavour('go')).toBeNull()
  })

  it('lets a flag change the dialect, including inside a cluster', () => {
    expect(applyFlavourFlag('-E')).toBe('ere')
    expect(applyFlavourFlag('-P')).toBe('pcre')
    expect(applyFlavourFlag('-rniE')).toBe('ere')
    expect(applyFlavourFlag('-F')).toBeNull()
    // Says nothing, so the caller keeps what it had.
    expect(applyFlavourFlag('-rn')).toBeUndefined()
    expect(applyFlavourFlag('--include=*.go')).toBeUndefined()
  })
})

describe('takesArgument', () => {
  it('knows which flags eat the word after them', () => {
    expect(takesArgument('-A')).toBe(true)
    expect(takesArgument('-rnA')).toBe(true)
    expect(takesArgument('--include')).toBe(true)
    // `-r` is recursive and takes nothing - reading a pattern as its argument
    // would lose every `grep -rn PATTERN` there is.
    expect(takesArgument('-r')).toBe(false)
    expect(takesArgument('-rn')).toBe(false)
    expect(takesArgument('--include=*.go')).toBe(false)
  })
})
