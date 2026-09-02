import { EXT_LANG_MAP } from './language'
import { LAZY_LANGUAGES, LAZY_LANGUAGE_ALIASES } from './prismLazyRegistry'

export interface LanguageOption {
  id: string
  label: string
  aliases: string[]
  extensions: string[]
  search: string
}

// Canonical names registered by the curated eager Prism bundle. Transitive
// dependencies that are useful choices are included too; aliases remain search
// terms rather than duplicate rows in the picker.
const EAGER_LANGUAGES = [
  'bash', 'c', 'clike', 'cpp', 'csharp', 'css', 'dart', 'diff', 'docker',
  'elixir', 'erlang', 'go', 'graphql', 'groovy', 'haskell', 'ini', 'java',
  'javascript', 'json', 'jsonnet', 'jsx', 'kotlin', 'less', 'log', 'lua',
  'makefile', 'markdown', 'markup', 'nginx', 'nix', 'objectivec', 'perl',
  'php', 'powershell', 'protobuf', 'python', 'r', 'ruby', 'rust', 'scala',
  'scss', 'sql', 'swift', 'toml', 'tsx', 'typescript', 'vim', 'yaml',
]

const EAGER_ALIASES: Record<string, string[]> = {
  bash: ['sh', 'shell'],
  csharp: ['cs', 'dotnet'],
  docker: ['dockerfile'],
  javascript: ['js'],
  json: ['webmanifest'],
  jsonnet: ['libsonnet'],
  makefile: ['make'],
  markdown: ['md'],
  markup: ['html', 'xml', 'svg'],
  objectivec: ['objc'],
  powershell: ['ps1'],
  protobuf: ['proto'],
  python: ['py'],
  typescript: ['ts'],
  yaml: ['yml'],
}

const DISPLAY_NAMES: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  clike: 'C-like',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  docker: 'Dockerfile',
  fsharp: 'F#',
  graphql: 'GraphQL',
  html: 'HTML',
  javascript: 'JavaScript',
  json: 'JSON',
  json5: 'JSON5',
  jsonnet: 'Jsonnet',
  jsx: 'JSX',
  lua: 'Lua',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  php: 'PHP',
  plaintext: 'Plain text',
  protobuf: 'Protocol Buffers',
  sql: 'SQL',
  svg: 'SVG',
  tsx: 'TSX',
  typescript: 'TypeScript',
  vbnet: 'Visual Basic .NET',
  wasm: 'WebAssembly',
  xml: 'XML',
  yaml: 'YAML',
}

export function languageDisplayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id
    .split('-')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ')
}

const extensionsByLanguage = new Map<string, string[]>()
for (const [ext, language] of Object.entries(EXT_LANG_MAP)) {
  const extensions = extensionsByLanguage.get(language) ?? []
  extensions.push(ext)
  extensionsByLanguage.set(language, extensions)
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  'plaintext',
  ...new Set([...EAGER_LANGUAGES, ...Object.keys(LAZY_LANGUAGES)]),
].map((id) => {
  const label = languageDisplayName(id)
  const aliases = [...new Set([...(EAGER_ALIASES[id] ?? []), ...(LAZY_LANGUAGE_ALIASES[id] ?? [])])]
  const extensions = extensionsByLanguage.get(id) ?? []
  return {
    id,
    label,
    aliases,
    extensions,
    search: [label, id, ...aliases, ...extensions.map((ext) => `.${ext}`), ...extensions].join(' ').toLowerCase(),
  }
}).sort((a, b) => a.label.localeCompare(b.label))

export function searchLanguages(query: string): LanguageOption[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return LANGUAGE_OPTIONS
  return LANGUAGE_OPTIONS.filter((option) => terms.every((term) => option.search.includes(term)))
}
