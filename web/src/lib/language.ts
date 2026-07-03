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

// getLanguage maps a file path to a highlight.js language name, or 'plaintext'
// when nothing sensible applies. Callers guard with hljs.getLanguage(...) (and the
// worker also lazy-loads it), so an unregistered name degrades to plain text.
export function getLanguage(filePath: string): string {
  const filename = filePath.split('/').pop() ?? filePath
  const lower = filename.toLowerCase()
  if (FILENAME_LANG_MAP[lower]) return FILENAME_LANG_MAP[lower]
  const ext = lower.split('.').pop() ?? ''
  return EXT_LANG_MAP[ext] ?? 'plaintext'
}
