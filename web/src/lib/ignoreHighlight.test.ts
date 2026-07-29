import { describe, it, expect } from 'vitest'
import { highlightIgnore, ignoreTokens, isIgnoreFile, isIgnoreLanguage } from './ignoreHighlight'

// A pattern as [text, kind] pairs, which reads as the line it is about.
function toks(line: string) {
  return ignoreTokens(line).map((t) => [t.text, t.kind])
}

describe('ignoreTokens', () => {
  it('leaves a plain path as text, with its separators marked', () => {
    expect(toks('/node_modules/')).toEqual([
      ['/', 'separator'], ['node_modules', 'literal'], ['/', 'separator'],
    ])
  })

  it('marks the wildcards and leaves the name they sit in alone', () => {
    expect(toks('/web/public/fonts/iosevka-*.woff2')).toEqual([
      ['/', 'separator'], ['web', 'literal'], ['/', 'separator'], ['public', 'literal'],
      ['/', 'separator'], ['fonts', 'literal'], ['/', 'separator'], ['iosevka-', 'literal'],
      ['*', 'meta'], ['.woff2', 'literal'],
    ])
  })

  it('reads `**` as one token, since it crosses directories where `*` does not', () => {
    expect(toks('**/build')).toEqual([['**', 'meta'], ['/', 'separator'], ['build', 'literal']])
    expect(toks('a**b')).toEqual([['a', 'literal'], ['**', 'meta'], ['b', 'literal']])
  })

  it('marks a leading `!` and nothing else', () => {
    expect(toks('!important.log')).toEqual([['!', 'meta'], ['important.log', 'literal']])
    // A bang inside a filename is a character in a filename.
    expect(toks('oh!.txt')).toEqual([['oh!.txt', 'literal']])
  })

  it('takes a comment only from the first column', () => {
    expect(toks('# Logs')).toEqual([['# Logs', 'comment']])
    // git reads these as patterns, hash and all.
    expect(toks(' # indented')).toEqual([[' # indented', 'literal']])
    expect(toks('a#b')).toEqual([['a#b', 'literal']])
  })

  it('marks the backslash of an escaped literal, and leaves the character it protects', () => {
    // `\#` matches a file called `#notes`, so the hash is text and only the
    // author's escape is syntax - the rule lib/regexHighlight follows.
    expect(toks('\\#notes')).toEqual([['\\', 'escape'], ['#notes', 'literal']])
    // An escaped star matches a star: it is not a wildcard.
    expect(toks('a\\*b')).toEqual([['a', 'literal'], ['\\', 'escape'], ['*b', 'literal']])
    // A trailing space kept by an escape.
    expect(toks('name\\ ')).toEqual([['name', 'literal'], ['\\', 'escape'], [' ', 'literal']])
  })

  it('splits a character set into its brackets and its characters', () => {
    expect(toks('*.[oa]')).toEqual([
      ['*', 'meta'], ['.', 'literal'], ['[', 'meta'], ['oa', 'class'], [']', 'meta'],
    ])
    expect(toks('[!a-c]x')).toEqual([['[!', 'meta'], ['a-c', 'class'], [']', 'meta'], ['x', 'literal']])
    // An unterminated bracket matches a bracket.
    expect(toks('[oa')).toEqual([['[oa', 'literal']])
  })

  it('never drops a character', () => {
    const lines = ['', '#', '!/a/**/b?.[ch]', 'a\\', '/x/y/', '\\!literal-bang']
    for (const line of lines) expect(ignoreTokens(line).map((t) => t.text).join('')).toBe(line)
  })
})

describe('highlightIgnore', () => {
  it('colours line by line, keeping the blank lines between groups', () => {
    expect(highlightIgnore('# Logs\n\n*.log')).toBe(
      '<span class="token comment"># Logs</span>\n\n'
      + '<span class="token operator">*</span>.log',
    )
  })

  it('escapes the text it emits', () => {
    expect(highlightIgnore('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
  })
})

describe('isIgnoreFile', () => {
  it('recognises the family by name, wherever the file sits', () => {
    for (const p of ['.gitignore', 'web/.gitignore', '.dockerignore', '.hydraignore', 'pkg/.npmignore']) {
      expect(isIgnoreFile(p)).toBe(true)
    }
  })

  it('needs the dot, so an ordinary word ending in "ignore" is not swept up', () => {
    for (const p of ['ignore', 'src/myignore', 'ignore.md', '.gitignore.bak', 'gitignore.go']) {
      expect(isIgnoreFile(p)).toBe(false)
    }
  })
})

describe('isIgnoreLanguage', () => {
  it('answers for the name lib/language produces and the fence names docs use', () => {
    expect(isIgnoreLanguage('gitignore')).toBe(true)
    expect(isIgnoreLanguage('dockerignore')).toBe(true)
    expect(isIgnoreLanguage('bash')).toBe(false)
  })
})
