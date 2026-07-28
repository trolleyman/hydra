// What a file IS, for the purpose of showing it: the one classifier the lightbox
// and everything that opens it (artifact tiles, attachment chips) route on.
//
// Everything here is by file EXTENSION, not by sniffing bytes or trusting a
// server Content-Type: the callers all have a name in hand long before they have
// the file, and a tile has to know how to lay itself out before it downloads
// anything. The cost is that an extensionless or misnamed file falls to 'binary'
// and gets the download card instead of a preview - a safe failure, since the
// alternative (a text viewer fetching a 200MB archive as a string) is not.
//
// The artifact-specific predicates in lib/artifactFilter build on this; they stay
// separate because the backend's collectible-extension allowlists
// (internal/artifacts) are narrower than what a user can attach to a prompt.

export type FileKind = 'image' | 'video' | 'pdf' | 'text' | 'binary'

// Still images the browser renders in an <img>. .webp is here rather than under
// video even when animated - the browser plays it in an <img> with no seek API,
// so there is nothing a video viewer could do with it (see VideoDiffView).
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)$/i
// Formats the browser plays in a <video>. The artifact pipeline only ever emits
// .webm, but an attachment can be anything the user drops on the composer.
const VIDEO_RE = /\.(webm|mp4|m4v|mov|ogv)$/i
const PDF_RE = /\.pdf$/i
// Text-ish files worth showing inline. Deliberately an allowlist: anything not
// named here reads as binary and gets the download card, so a mystery file is
// never fetched into a <pre>.
const TEXT_RE = new RegExp(
  '\\.(txt|text|log|md|markdown|rst|adoc|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|properties'
  + '|csv|tsv|xml|html?|css|scss|less|svgz?'
  + '|[cm]?[jt]sx?|go|py|rb|rs|java|kt|kts|swift|php|pl|lua|sql|sh|bash|zsh|fish|ps1|bat'
  + '|c|h|cc|cpp|cxx|hpp|hh|cs|m|mm|scala|clj|ex|exs|erl|hs|r|jl|zig|nim|vue|svelte'
  + '|diff|patch|gradle|cmake|mk|dockerfile|gitignore|editorconfig|lock)$',
  'i',
)
// Files with no extension at all that are conventionally text (README, LICENSE,
// Makefile, Dockerfile). A bare name with no dot is otherwise unclassifiable.
const TEXT_STEM_RE = /^(readme|license|licence|copying|authors|changelog|notice|makefile|dockerfile|procfile|codeowners|gemfile|rakefile|justfile)$/i

export function fileKind(name: string): FileKind {
  if (IMAGE_RE.test(name)) return 'image'
  if (VIDEO_RE.test(name)) return 'video'
  if (PDF_RE.test(name)) return 'pdf'
  if (TEXT_RE.test(name)) return 'text'
  const base = name.split('/').pop() ?? name
  // A dotfile ('.gitignore') is a stem, not an extension - strip the leading dot
  // before asking whether the name itself is one of the conventional text ones.
  if (!base.includes('.', 1) && TEXT_STEM_RE.test(base.replace(/^\./, ''))) return 'text'
  return 'binary'
}

// LANG_BY_EXT maps a file extension to a Prism language, so a file's contents can
// be syntax highlighted by the name it was read under. Shared by the chat's Read
// tool cards and the lightbox's text viewer.
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', go: 'go', py: 'python',
  rb: 'ruby', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', md: 'markdown', markdown: 'markdown', html: 'xml',
  xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql', lua: 'lua',
  dockerfile: 'dockerfile', diff: 'diff', patch: 'diff',
}

export function langFromPath(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? (LANG_BY_EXT[ext] ?? '') : ''
}
