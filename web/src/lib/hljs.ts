// Curated highlight.js build.
//
// Importing the default `highlight.js` entry registers ALL ~190 languages
// (~900 kB minified) into every chunk that touches it — the main app bundle and
// the highlight Web Worker alike — so highlight.js alone was two 900 kB+ chunks.
//
// Instead we build from the lightweight `core` and eagerly register only a common
// set of languages here (bundled, usable synchronously everywhere). The long tail
// of ~150 rarer languages is loaded on demand — see hljsLazy.ensureLanguage, used
// by the highlight worker so the diff viewer can still colourise anything without
// paying for it up front.
//
// Every call site guards with hljs.getLanguage(...) or falls back to plain,
// HTML-escaped text (highlightCore.highlightLines), so a language that is neither
// eager nor yet lazy-loaded simply renders as plain text.
import hljs from 'highlight.js/lib/core'

import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import dart from 'highlight.js/lib/languages/dart'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import elixir from 'highlight.js/lib/languages/elixir'
import erlang from 'highlight.js/lib/languages/erlang'
import go from 'highlight.js/lib/languages/go'
import graphql from 'highlight.js/lib/languages/graphql'
import groovy from 'highlight.js/lib/languages/groovy'
import haskell from 'highlight.js/lib/languages/haskell'
import ini from 'highlight.js/lib/languages/ini' // registers the `toml` alias too
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import lua from 'highlight.js/lib/languages/lua'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import nix from 'highlight.js/lib/languages/nix'
import objectivec from 'highlight.js/lib/languages/objectivec'
import perl from 'highlight.js/lib/languages/perl'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import protobuf from 'highlight.js/lib/languages/protobuf'
import python from 'highlight.js/lib/languages/python'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scala from 'highlight.js/lib/languages/scala'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import vim from 'highlight.js/lib/languages/vim'
import xml from 'highlight.js/lib/languages/xml' // registers the `html`/`svg` aliases too
import yaml from 'highlight.js/lib/languages/yaml'

const EAGER = {
  bash, c, cpp, csharp, css, dart, diff, dockerfile, elixir, erlang, go, graphql,
  groovy, haskell, ini, java, javascript, json, kotlin, less, lua, makefile,
  markdown, nginx, nix, objectivec, perl, php, powershell, protobuf, python, r,
  ruby, rust, scala, scss, shell, sql, swift, typescript, vim, xml, yaml,
}

for (const [name, lang] of Object.entries(EAGER)) hljs.registerLanguage(name, lang)

export default hljs
