import { describe, it, expect } from 'vitest'
import hljs from './hljs'
import { ensureLanguage } from './hljsLazy'
import { getLanguage } from './language'

describe('getLanguage', () => {
  it('maps common extensions to highlight.js languages', () => {
    expect(getLanguage('src/main.ts')).toBe('typescript')
    expect(getLanguage('main.go')).toBe('go')
    expect(getLanguage('init.lua')).toBe('lua')
    expect(getLanguage('lib.rs')).toBe('rust')
    expect(getLanguage('app.py')).toBe('python')
    expect(getLanguage('config.toml')).toBe('toml')
  })

  it('recognises special filenames regardless of extension', () => {
    expect(getLanguage('deploy/Dockerfile')).toBe('dockerfile')
    expect(getLanguage('Makefile')).toBe('makefile')
    expect(getLanguage('go.mod')).toBe('plaintext')
  })

  it('falls back to plaintext for unknown extensions', () => {
    expect(getLanguage('data.unknownext')).toBe('plaintext')
    expect(getLanguage('LICENSE')).toBe('plaintext')
  })
})

describe('eager highlight.js languages', () => {
  it('bundles lua and other common languages up front', () => {
    for (const lang of ['lua', 'typescript', 'go', 'python', 'rust', 'bash', 'json', 'yaml']) {
      expect(hljs.getLanguage(lang), lang).toBeTruthy()
    }
  })

  it('resolves aliases of eager languages', () => {
    expect(hljs.getLanguage('toml')).toBeTruthy() // via ini
    expect(hljs.getLanguage('html')).toBeTruthy() // via xml
  })

  it('does not eagerly bundle rare languages', () => {
    expect(hljs.getLanguage('clojure')).toBeFalsy()
  })
})

describe('ensureLanguage (on-demand loading)', () => {
  it('lazily loads and registers a language, making it highlightable', async () => {
    expect(hljs.getLanguage('ocaml')).toBeFalsy()
    expect(await ensureLanguage('ocaml')).toBe(true)
    expect(hljs.getLanguage('ocaml')).toBeTruthy()
    const html = hljs.highlight('let x = 1', { language: 'ocaml' }).value
    expect(html).toContain('hljs-') // produced token markup, not plain text
  })

  it('is a no-op (true) for an already-registered eager language', async () => {
    expect(await ensureLanguage('lua')).toBe(true)
  })

  it('returns false for plaintext and unknown languages', async () => {
    expect(await ensureLanguage('plaintext')).toBe(false)
    expect(await ensureLanguage('definitely-not-a-language')).toBe(false)
  })
})
