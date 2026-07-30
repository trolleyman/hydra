// Curated Prism build, via refractor.
//
// refractor is Prism's grammars packaged as ESM with a hast (HTML AST) output,
// which is what makes it usable here: plain `prismjs` is a CJS bundle that
// mutates a global, which neither Vite's module graph nor the highlight Web
// Worker can lazy-load a language into. `refractor/core` starts empty and every
// grammar is a separate ESM import.
//
// Importing `refractor/all` would register all ~297 grammars into every chunk
// that touches this module - the main bundle AND the worker. Instead the common
// set below is registered eagerly (bundled, usable synchronously everywhere) and
// the long tail loads on demand - see prismLazy.ensureLanguage, used by the
// highlight worker so the diff viewer can colourise anything without paying for
// it up front.
//
// Every call site guards with hasLanguage(...) or falls back to plain,
// HTML-escaped text (highlightCore.highlightLines), so a language that is
// neither eager nor yet lazy-loaded simply renders as plain text.
//
// Prism, not highlight.js, because hljs has no JSX grammar - it reads a JSX tag
// as XML, and an angle-bracketed word anywhere inside the element (even in a
// `//` comment, which XML has no notion of) swallows the closing tag and leaves
// the rest of the file untokenized. Measured over this repo, hljs stopped short
// on 18 of 633 files - 12% of the way through DiffViewer.tsx - against 0 for
// Prism, at the same speed and with far smaller grammars (tsx: 0.55 kB gzipped
// against 8.3 kB for hljs's ts+js+xml chain).
import { refractor } from 'refractor/core'

import bash from 'refractor/bash'
import c from 'refractor/c'
import clike from 'refractor/clike'
import cpp from 'refractor/cpp'
import csharp from 'refractor/csharp'
import css from 'refractor/css'
import dart from 'refractor/dart'
import diff from 'refractor/diff'
import docker from 'refractor/docker'
import elixir from 'refractor/elixir'
import erlang from 'refractor/erlang'
import go from 'refractor/go'
import graphql from 'refractor/graphql'
import groovy from 'refractor/groovy'
import haskell from 'refractor/haskell'
import ini from 'refractor/ini'
import java from 'refractor/java'
import javascript from 'refractor/javascript'
import json from 'refractor/json'
import jsx from 'refractor/jsx'
import kotlin from 'refractor/kotlin'
import less from 'refractor/less'
import log from 'refractor/log'
import lua from 'refractor/lua'
import makefile from 'refractor/makefile'
import markdown from 'refractor/markdown'
import markup from 'refractor/markup'
import nginx from 'refractor/nginx'
import nix from 'refractor/nix'
import objectivec from 'refractor/objectivec'
import perl from 'refractor/perl'
import php from 'refractor/php'
import powershell from 'refractor/powershell'
import protobuf from 'refractor/protobuf'
import python from 'refractor/python'
import r from 'refractor/r'
import ruby from 'refractor/ruby'
import rust from 'refractor/rust'
import scala from 'refractor/scala'
import scss from 'refractor/scss'
import sql from 'refractor/sql'
import swift from 'refractor/swift'
import toml from 'refractor/toml'
import tsx from 'refractor/tsx'
import typescript from 'refractor/typescript'
import vim from 'refractor/vim'
import yaml from 'refractor/yaml'

// Order matters only in that a grammar's dependencies must already be present;
// refractor's own syntax modules declare theirs, so this is just the eager list.
const EAGER = [
  clike, markup, css, javascript, // the roots the rest extend
  bash, c, cpp, csharp, dart, diff, docker, elixir, erlang, go, graphql, groovy,
  haskell, ini, java, json, jsx, kotlin, less, log, lua, makefile, markdown, nginx,
  nix, objectivec, perl, php, powershell, protobuf, python, r, ruby, rust, scala,
  scss, sql, swift, toml, tsx, typescript, vim, yaml,
]

for (const lang of EAGER) refractor.register(lang)

// hasLanguage reports whether a grammar is registered and usable right now.
// Aliases count: refractor resolves `html` to markup, `ts` to typescript.
export function hasLanguage(name: string): boolean {
  return !!name && name !== 'plaintext' && refractor.registered(name)
}

export { refractor }
