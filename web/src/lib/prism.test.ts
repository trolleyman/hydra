import { describe, it, expect } from 'vitest'
import { refractor, hasLanguage } from './prism'
import { ensureLanguage } from './prismLazy'
import { LAZY_LANGUAGES } from './prismLazyRegistry'
import { getLanguage, shebangLanguage } from './language'
import { canHighlight } from './highlightCore'
import { highlightToHtml } from './prismHtml'

describe('getLanguage', () => {
  it('maps common extensions to Prism grammars', () => {
    expect(getLanguage('src/main.ts')).toBe('typescript')
    expect(getLanguage('main.go')).toBe('go')
    expect(getLanguage('init.lua')).toBe('lua')
    expect(getLanguage('lib.rs')).toBe('rust')
    expect(getLanguage('app.py')).toBe('python')
    expect(getLanguage('config.toml')).toBe('toml')
    // A log is the commonest thing a Bash card reads out, and Prism has a
    // grammar for one: the timestamp, the level and the paths in the message.
    expect(getLanguage('watch.log')).toBe('log')
  })

  it('maps the JSX-bearing extensions to the JSX grammars, not the plain ones', () => {
    // The whole point of the Prism switch: .tsx is tsx, not typescript. A JSX
    // element highlighted by the plain grammar is what used to derail the file.
    expect(getLanguage('src/App.tsx')).toBe('tsx')
    expect(getLanguage('src/App.jsx')).toBe('jsx')
    // ...while .ts stays typescript, where `<T>` is a type argument, not a tag.
    expect(getLanguage('src/util.ts')).toBe('typescript')
  })

  it('recognises special filenames regardless of extension', () => {
    expect(getLanguage('deploy/Dockerfile')).toBe('docker')
    expect(getLanguage('Makefile')).toBe('makefile')
    expect(getLanguage('go.mod')).toBe('plaintext')
  })

  it('reads the ignore-file family by name', () => {
    // No extension to key on, and the family is open-ended - see
    // lib/ignoreHighlight, which highlights the result without a Prism grammar.
    expect(getLanguage('web/.gitignore')).toBe('gitignore')
    expect(getLanguage('.dockerignore')).toBe('gitignore')
    expect(getLanguage('.hydraignore')).toBe('gitignore')
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

  it('only ever names a grammar Prism can actually load', () => {
    // Guards the whole extension/filename/shebang table against a typo or a
    // rename in refractor: a name that is neither eager nor lazily loadable
    // silently degrades that language to plain text, which is invisible in
    // review. 'plaintext' is the deliberate "no highlighting" sentinel.
    //
    // Checked against the registry rather than by calling ensureLanguage, so
    // this doesn't register grammars into the module-level refractor instance
    // the other tests here assert the eager set of.
    const paths = [
      'a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.json', 'a.html', 'a.xml',
      'a.svg', 'a.vue', 'a.svelte', 'a.css', 'a.scss', 'a.less', 'a.styl', 'a.go',
      'a.rs', 'a.c', 'a.h', 'a.cpp', 'a.cs', 'a.swift', 'a.dart', 'a.nim', 'a.d',
      'a.v', 'a.vhdl', 'a.wasm', 'a.java', 'a.kt', 'a.scala', 'a.groovy', 'a.clj',
      'a.py', 'a.rb', 'a.pl', 'a.lua', 'a.r', 'a.php', 'a.tcl', 'a.coffee', 'a.ex',
      'a.erl', 'a.hs', 'a.ml', 'a.fs', 'a.elm', 'a.jl', 'a.lisp', 'a.scm', 'a.sh',
      'a.ps1', 'a.bat', 'a.yaml', 'a.toml', 'a.ini', 'a.properties', 'a.sql',
      'a.graphql', 'a.proto', 'a.md', 'a.tex', 'a.m', 'a.glsl', 'a.f90', 'a.vim',
      'a.pp', 'a.vala', 'a.hx', 'a.cr', 'a.cmake', 'a.feature', 'a.diff',
      'Dockerfile', 'Makefile', 'CMakeLists.txt', 'Gemfile', '.gitignore',
    ]
    const names = new Set(paths.map((p) => getLanguage(p)))
    for (const shebang of ['python3', 'ruby', 'perl', 'node', 'deno', 'lua', 'awk', 'osascript', 'julia', 'racket', 'make']) {
      names.add(getLanguage('script', `#!/usr/bin/env ${shebang}`))
    }
    // canHighlight, not hasLanguage: `gitignore` is coloured by
    // lib/ignoreHighlight rather than by a grammar, and is not a typo.
    const missing = [...names].filter((n) => n !== 'plaintext' && !canHighlight(n) && !(n in LAZY_LANGUAGES))
    expect(missing).toEqual([])
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

describe('eager Prism grammars', () => {
  it('bundles lua and other common languages up front', () => {
    for (const lang of ['lua', 'typescript', 'tsx', 'go', 'python', 'rust', 'bash', 'json', 'yaml', 'log']) {
      expect(hasLanguage(lang), lang).toBe(true)
    }
  })

  it('resolves aliases of eager grammars', () => {
    expect(hasLanguage('html')).toBe(true) // via markup
    expect(hasLanguage('ts')).toBe(true) // via typescript
  })

  it('does not eagerly bundle rare languages', () => {
    expect(hasLanguage('clojure')).toBe(false)
  })

  it('reports plaintext and unknown names as unhighlightable', () => {
    expect(hasLanguage('plaintext')).toBe(false)
    expect(hasLanguage('definitely-not-a-language')).toBe(false)
    expect(hasLanguage('')).toBe(false)
  })

  it('never lists an eagerly-bundled grammar as lazy too', () => {
    const both = Object.keys(LAZY_LANGUAGES).filter((n) => refractor.registered(n))
    expect(both).toEqual([])
  })
})

describe('ensureLanguage (on-demand loading)', () => {
  it('lazily loads and registers a grammar, making it highlightable', async () => {
    expect(hasLanguage('ocaml')).toBe(false)
    expect(await ensureLanguage('ocaml')).toBe(true)
    expect(hasLanguage('ocaml')).toBe(true)
    expect(highlightToHtml('let x = 1', 'ocaml')).toContain('token') // markup, not plain text
  })

  it('is a no-op (true) for an already-registered eager grammar', async () => {
    expect(await ensureLanguage('lua')).toBe(true)
  })

  it('returns false for plaintext and unknown languages', async () => {
    expect(await ensureLanguage('plaintext')).toBe(false)
    expect(await ensureLanguage('definitely-not-a-language')).toBe(false)
  })
})
