// File-extension → highlight.js language name, shared by the diff viewer
// (DiffViewer) and the repository file browser (RepositoryView) so both detect the
// same set. Names here may be eager (bundled, see hljs.ts) or lazy (loaded on
// demand, see hljsLazy.ts); an entry mapping to a lazy language colourises in the
// diff viewer (which highlights via the async worker) and, once loaded, in the file
// browser - anything unmapped or not-yet-loaded renders as plain text.
const EXT_LANG_MAP: Record<string, string> = {
  // Web / TS-JS
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', xhtml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'stylus',
  // Systems / compiled
  go: 'go', rs: 'rust', c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'csharp', swift: 'swift', dart: 'dart',
  zig: 'plaintext', nim: 'nim', d: 'd', v: 'verilog', sv: 'verilog',
  vhdl: 'vhdl', vhd: 'vhdl', wasm: 'wasm', wat: 'wasm',
  // JVM / adjacent
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sbt: 'scala',
  groovy: 'groovy', gradle: 'groovy', clj: 'clojure', cljs: 'clojure',
  cljc: 'clojure', edn: 'clojure',
  // Scripting
  py: 'python', pyw: 'python', rb: 'ruby', pl: 'perl', pm: 'perl',
  lua: 'lua', r: 'r', php: 'php', tcl: 'tcl', coffee: 'coffeescript',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  // Functional
  hs: 'haskell', lhs: 'haskell', ml: 'ocaml', mli: 'ocaml', fs: 'fsharp',
  fsx: 'fsharp', elm: 'elm', jl: 'julia', lisp: 'lisp', el: 'lisp',
  scm: 'scheme', ss: 'scheme',
  // Shells / config
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  bat: 'dos', cmd: 'dos', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  // Data / IDL / query
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  // Markup / docs
  md: 'markdown', markdown: 'markdown', tex: 'latex', latex: 'latex',
  // Native / GPU / other
  m: 'objectivec', mm: 'objectivec', glsl: 'glsl', vert: 'glsl', frag: 'glsl',
  f: 'fortran', f90: 'fortran', f95: 'fortran', vim: 'vim', pp: 'puppet',
  vala: 'vala', hx: 'haxe', cr: 'crystal', cmake: 'cmake', feature: 'gherkin',
  diff: 'diff', patch: 'diff',
}

// Filenames (case-insensitive) that pin a language regardless of extension.
const FILENAME_LANG_MAP: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
  // Lockfiles / manifests with no useful grammar → leave plain.
  'go.mod': 'plaintext',
  'go.sum': 'plaintext',
}

// Interpreter (the `#!` line's command, basename only) → highlight.js language.
// Keys are matched after stripping the directory, any `env` wrapper and a trailing
// version suffix, so one entry covers a whole family (`python3`, `python3.12`,
// `/usr/local/bin/python3.12` all land on `python`).
const SHEBANG_LANG_MAP: Record<string, string> = {
  // Shells - hljs 'bash' is the closest grammar for all of them.
  sh: 'bash', bash: 'bash', dash: 'bash', ash: 'bash', ksh: 'bash', zsh: 'bash',
  fish: 'bash', pwsh: 'powershell', powershell: 'powershell',
  // Scripting
  python: 'python', pypy: 'python', ruby: 'ruby', perl: 'perl', php: 'php',
  lua: 'lua', luajit: 'lua', tclsh: 'tcl', wish: 'tcl', expect: 'tcl',
  awk: 'awk', gawk: 'awk', mawk: 'awk', rscript: 'r', osascript: 'applescript',
  // JS / TS runtimes
  node: 'javascript', nodejs: 'javascript', deno: 'typescript', bun: 'typescript',
  'ts-node': 'typescript', tsx: 'typescript',
  // Compiled languages with a script mode
  julia: 'julia', elixir: 'elixir', escript: 'erlang', groovy: 'groovy',
  scala: 'scala', swift: 'swift', crystal: 'crystal', guile: 'scheme',
  racket: 'scheme', make: 'makefile',
}

// shebangLanguage reads the interpreter out of a `#!` line and maps it to a
// highlight.js language, or null when there is no shebang / no mapping. Handles
// the shapes that actually turn up:
//   #!/bin/sh -e                        → bash
//   #!/usr/bin/env python3               → python
//   #!/usr/bin/env -S NODE_ENV=x node -u → javascript
export function shebangLanguage(firstLine: string): string | null {
  // The `#!` has to be the file's very first bytes (a BOM aside) to be a shebang.
  const line = firstLine.replace(/^\uFEFF/, '').split('\n')[0]
  if (!line.startsWith('#!')) return null
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  let interp = tokens[0]
  if (basename(interp) === 'env') {
    // env defers to its first argument that is neither a flag nor a VAR=value
    // assignment (`--split-string=cmd` carries the command in the flag itself).
    const arg = tokens.slice(1).find((t) => !t.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
      ?? tokens.slice(1).map((t) => /^--split-string=(.+)$/.exec(t)?.[1]).find(Boolean)
    if (!arg) return null
    interp = arg
  }
  const name = basename(interp).toLowerCase()
  // `python3.12` → `python`, `perl5` → `perl`; try the exact name first so a
  // legitimately digit-suffixed interpreter still wins.
  return SHEBANG_LANG_MAP[name] ?? SHEBANG_LANG_MAP[name.replace(/[\d.]+$/, '')] ?? null
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

// getLanguage maps a file path to a highlight.js language name, or 'plaintext'
// when nothing sensible applies. Callers guard with hljs.getLanguage(...) (and the
// worker also lazy-loads it), so an unregistered name degrades to plain text.
//
// `head` is the start of the file's content (the first line is enough) and is only
// consulted when the path says nothing - an extension-less `bin/deploy` starting
// with `#!/usr/bin/env python3` highlights as Python. Path mappings still win, so a
// `.py` file with a `#!/bin/sh` line stays Python and the deliberate plaintext
// entries above (go.sum and friends) stay plain.
export function getLanguage(filePath: string, head?: string | null): string {
  const filename = filePath.split('/').pop() ?? filePath
  const lower = filename.toLowerCase()
  if (FILENAME_LANG_MAP[lower]) return FILENAME_LANG_MAP[lower]
  const ext = lower.split('.').pop() ?? ''
  return EXT_LANG_MAP[ext] ?? (head ? shebangLanguage(head) : null) ?? 'plaintext'
}
