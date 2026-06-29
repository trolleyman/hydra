// Helpers for the spawn composer's "attach large text pastes" behavior.
//
// A paste taller than PASTE_LINE_THRESHOLD lines is turned into a file
// attachment rather than dumped into the textarea (it would otherwise bury the
// task description). Pasting the SAME block again is read as "no, I really want
// it inline" and the text is inserted for real — wrapped in a fenced code block
// when the clipboard says it's code (see detectCodeLanguage). SpawnForm owns
// that state machine; this module just provides the pure clipboard helpers.

// Pastes with MORE than this many lines are attached instead of inlined.
export const PASTE_LINE_THRESHOLD = 8

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
// HTML representation — the user's "tagged as html" case.
function looksLikeMarkup(text: string): boolean {
  const t = text.trim()
  return t.startsWith('<') && /<[a-z!][\s\S]*>/i.test(t)
}

// If the clipboard says the payload is code, returns its fence tag (e.g. 'html',
// 'go', 'tsx'); otherwise null. We trust VS Code's `vscode-editor-data` blob
// first — it carries the exact editor language — and fall back to sniffing an
// HTML representation, since generic clipboards don't record a language.
export function detectCodeLanguage(dt: DataTransfer | null): string | null {
  if (!dt) return null
  const vscode = dt.getData('vscode-editor-data')
  if (vscode) {
    try {
      const mode = (JSON.parse(vscode) as { mode?: unknown }).mode
      if (typeof mode === 'string' && mode && mode !== 'plaintext') return normalizeLang(mode)
    } catch {
      // Not the JSON shape we expect — ignore and try the markup fallback.
    }
  }
  if (dt.types.includes('text/html') && looksLikeMarkup(getClipboardText(dt))) return 'html'
  return null
}

// Wraps text in a fenced code block with the given language tag.
export function fenceCode(text: string, lang: string): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``
}
