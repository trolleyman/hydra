// Helpers for the spawn composer's "attach large text pastes" behavior.
//
// A paste over PASTE_LINE_THRESHOLD lines or PASTE_CHAR_THRESHOLD characters
// (see isLargePaste) is turned into a file attachment rather than dumped into
// the textarea (it would otherwise bury the task description). Pasting the SAME
// block again is read as "no, I really want it inline" and the text is inserted
// for real - wrapped in a fenced code block when the clipboard says it's code
// (see detectCodeLanguage). A Shift-held paste (Ctrl/Cmd+Shift+V) bypasses all
// of this and inserts literally. SpawnForm owns that state machine; this module
// just provides the pure clipboard helpers.

// Pastes with MORE than this many lines are attached instead of inlined.
export const PASTE_LINE_THRESHOLD = 8

// ...or more than this many characters, so a dense few-line blob (a minified
// bundle, a long token, a wide single line) is lifted out of the box too.
export const PASTE_CHAR_THRESHOLD = 1000

// Whether a paste is big enough to attach rather than inline: over the line OR
// the character threshold.
export function isLargePaste(text: string): boolean {
  return countLines(text) > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD
}

// The plain-text representation of a clipboard/drag payload, '' if none.
export function getClipboardText(dt: DataTransfer | null): string {
  return dt?.getData('text/plain') ?? ''
}

// Line count of a block (0 for empty). A trailing newline doesn't add a line.
export function countLines(text: string): number {
  if (text === '') return 0
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n').length
}

// VS Code language ids that don't match a conventional Markdown fence tag.
const LANG_ALIASES: Record<string, string> = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  shellscript: 'bash',
  jsonc: 'json',
  dockerfile: 'docker',
}

function normalizeLang(mode: string): string {
  return LANG_ALIASES[mode] ?? mode
}

// True when the text looks like HTML/XML markup (opens with a tag). Used as the
// fallback when the clipboard carries no explicit language but advertises an
// HTML representation - the user's "tagged as html" case.
function looksLikeMarkup(text: string): boolean {
  const t = text.trim()
  return t.startsWith('<') && /<[a-z!][\s\S]*>/i.test(t)
}

// If the clipboard says the payload is code, returns its fence tag (e.g. 'html',
// 'go', 'tsx'); otherwise null. We trust VS Code's `vscode-editor-data` blob
// first - it carries the exact editor language - and fall back to sniffing an
// HTML representation, since generic clipboards don't record a language.
export function detectCodeLanguage(dt: DataTransfer | null): string | null {
  if (!dt) return null
  const vscode = dt.getData('vscode-editor-data')
  if (vscode) {
    try {
      const mode = (JSON.parse(vscode) as { mode?: unknown }).mode
      if (typeof mode === 'string' && mode && mode !== 'plaintext') return normalizeLang(mode)
    } catch {
      // Not the JSON shape we expect - ignore and try the markup fallback.
    }
  }
  if (dt.types.includes('text/html') && looksLikeMarkup(getClipboardText(dt))) return 'html'
  return null
}

// Wraps text in a fenced code block with the given language tag.
export function fenceCode(text: string, lang: string): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``
}

// Fence/language tags (see detectCodeLanguage) whose file extension isn't just
// the tag itself. Anything not listed is used verbatim (go, json, html, css,
// tsx, jsx, sql, java, php, swift, kotlin, toml, xml, scss, ...), which already
// matches the conventional extension.
const LANG_TO_EXT: Record<string, string> = {
  markdown: 'md',
  bash: 'sh',
  shellscript: 'sh',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  typescript: 'ts',
  javascript: 'js',
  csharp: 'cs',
  cpp: 'cpp',
  yaml: 'yml',
  docker: 'dockerfile',
}

// The file extension (no leading dot) to save a pasted text block under. Uses
// only what the clipboard DECLARES - the editor language (VS Code copies:
// markdown -> md, python -> py, ...) or an offered HTML representation - with no
// content sniffing. When the clipboard says nothing, it's plain 'txt'.
export function pastedTextExtension(dt: DataTransfer | null): string {
  const lang = detectCodeLanguage(dt)
  if (lang) return LANG_TO_EXT[lang] ?? lang
  return 'txt'
}

// The MIME type to stamp on a saved paste of the given extension. Only affects
// the client-side File object; the backend infers content-type from the name.
export function extensionMime(ext: string): string {
  if (ext === 'md') return 'text/markdown'
  if (ext === 'html') return 'text/html'
  return 'text/plain'
}
