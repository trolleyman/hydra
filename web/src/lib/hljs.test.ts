import { describe, it, expect } from 'vitest'
import hljs from './hljs'
import { ensureLanguage } from './hljsLazy'
import { getLanguage, shebangLanguage } from './language'

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

  it('falls back to the shebang when the path says nothing', () => {
    expect(getLanguage('scripts/deploy', '#!/usr/bin/env python3\nimport os')).toBe('python')
    expect(getLanguage('bin/build', '#!/bin/sh -e\nset -u')).toBe('bash')
    expect(getLanguage('hook.unknownext', '#!/usr/bin/env node')).toBe('javascript')
    expect(getLanguage('scripts/deploy', 'no shebang here')).toBe('plaintext')
    expect(getLanguage('scripts/deploy')).toBe('plaintext')
  })

  it('lets the path win over the shebang', () => {
    // A .py file claiming /bin/sh is still Python; deliberate plaintext stays plain.
    expect(getLanguage('app.py', '#!/bin/sh')).toBe('python')
    expect(getLanguage('go.mod', '#!/bin/sh')).toBe('plaintext')
  })
})

describe('shebangLanguage', () => {
  it('reads the interpreter through paths, versions and env', () => {
    expect(shebangLanguage('#!/bin/bash')).toBe('bash')
    expect(shebangLanguage('#!/usr/local/bin/python3.12 -u')).toBe('python')
    expect(shebangLanguage('#! /usr/bin/env  perl5')).toBe('perl')
    expect(shebangLanguage('#!/usr/bin/env -S NODE_ENV=x node --enable-source-maps')).toBe('javascript')
    expect(shebangLanguage('#!/usr/bin/env --split-string=ruby -w')).toBe('ruby')
    expect(shebangLanguage('#!/usr/bin/env deno run --allow-net')).toBe('typescript')
  })

  it('returns null when there is no usable shebang', () => {
    expect(shebangLanguage('#include <stdio.h>')).toBeNull()
    expect(shebangLanguage('')).toBeNull()
    expect(shebangLanguage('#!')).toBeNull()
    expect(shebangLanguage('#!/usr/bin/env')).toBeNull()
    expect(shebangLanguage('#!/usr/bin/somethingelse')).toBeNull()
    expect(shebangLanguage('  #!/bin/bash')).toBeNull() // must be the very first bytes
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
