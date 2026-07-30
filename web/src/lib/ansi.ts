// stripAnsi removes ANSI escape sequences (colour/style codes like ESC[2m,
// ESC[22m, cursor moves, etc.) from a string so raw terminal output renders as
// plain text in the UI. The pattern is the well-known ansi-regex one, built
// from a string so the ESC / CSI bytes are unambiguous; we inline it rather
// than pull in a dependency for a single one-liner.
const ANSI_PATTERN =
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'

export function stripAnsi(input: string): string {
  return input.replace(new RegExp(ANSI_PATTERN, 'g'), '')
}

// Control bytes, built from char codes so no raw ESC/BEL byte lands in source
// (a literal control byte trips grep and other tooling; see CLAUDE.md).
const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b) // single-byte CSI
const BEL = String.fromCharCode(0x07)

// hasAnsi reports whether a string carries escape/CSI bytes or a bare carriage
// return worth handling - a cheap gate so plain output skips the converter.
export function hasAnsi(input: string): boolean {
  return input.includes(ESC) || input.includes(CSI) || input.includes('\r')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ANSI SGR colour code -> CSS class (theme-aware colours live in index.css).
const FG_CLASS: Record<number, string> = {
  30: 'ansi-black', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow',
  34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan', 37: 'ansi-white',
  90: 'ansi-bright-black', 91: 'ansi-bright-red', 92: 'ansi-bright-green', 93: 'ansi-bright-yellow',
  94: 'ansi-bright-blue', 95: 'ansi-bright-magenta', 96: 'ansi-bright-cyan', 97: 'ansi-bright-white',
}
const BG_CLASS: Record<number, string> = {
  40: 'ansi-bg-black', 41: 'ansi-bg-red', 42: 'ansi-bg-green', 43: 'ansi-bg-yellow',
  44: 'ansi-bg-blue', 45: 'ansi-bg-magenta', 46: 'ansi-bg-cyan', 47: 'ansi-bg-white',
  100: 'ansi-bg-bright-black', 101: 'ansi-bg-bright-red', 102: 'ansi-bg-bright-green', 103: 'ansi-bg-bright-yellow',
  104: 'ansi-bg-bright-blue', 105: 'ansi-bg-bright-magenta', 106: 'ansi-bg-bright-cyan', 107: 'ansi-bg-bright-white',
}

// The SGR attributes tracked across a run of text. fg/bg are either a palette
// class name or an inline `#rrggbb` for 256-colour / truecolour.
interface SgrState {
  fg: string | null
  bg: string | null
  fgHex: string | null
  bgHex: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}
function emptyState(): SgrState {
  return { fg: null, bg: null, fgHex: null, bgHex: null, bold: false, dim: false, italic: false, underline: false }
}

// The 256-colour cube -> #rrggbb (16 base + 216 cube + 24 greyscale), so 8-bit
// and 24-bit colours render as inline styles rather than being dropped.
const XTERM_BASE = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
]
function hex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}
function xterm256Hex(n: number): string {
  if (n < 16) return XTERM_BASE[n]
  if (n < 232) {
    const c = n - 16
    const r = Math.floor(c / 36), g = Math.floor((c % 36) / 6), b = c % 6
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40)
    return `#${hex2(v(r))}${hex2(v(g))}${hex2(v(b))}`
  }
  const v = 8 + (n - 232) * 10
  return `#${hex2(v)}${hex2(v)}${hex2(v)}`
}

function stateClasses(s: SgrState): string {
  const cls: string[] = []
  if (s.fg) cls.push(s.fg)
  if (s.bg) cls.push(s.bg)
  if (s.bold) cls.push('ansi-bold')
  if (s.dim) cls.push('ansi-dim')
  if (s.italic) cls.push('ansi-italic')
  if (s.underline) cls.push('ansi-underline')
  return cls.join(' ')
}
function stateStyle(s: SgrState): string {
  const st: string[] = []
  if (s.fgHex) st.push(`color:${s.fgHex}`)
  if (s.bgHex) st.push(`background-color:${s.bgHex}`)
  return st.join(';')
}

// applySgr mutates the state for one SGR parameter list (the numbers in ESC[...m).
function applySgr(s: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) Object.assign(s, emptyState())
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 22) { s.bold = false; s.dim = false }
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 39) { s.fg = null; s.fgHex = null }
    else if (p === 49) { s.bg = null; s.bgHex = null }
    else if (FG_CLASS[p]) { s.fg = FG_CLASS[p]; s.fgHex = null }
    else if (BG_CLASS[p]) { s.bg = BG_CLASS[p]; s.bgHex = null }
    // 256-colour (38;5;n) and truecolour (38;2;r;g;b), plus their bg 48;... forms.
    else if (p === 38 || p === 48) {
      const isFg = p === 38
      if (params[i + 1] === 5 && params[i + 2] != null) {
        const hex = xterm256Hex(params[i + 2])
        if (isFg) { s.fgHex = hex; s.fg = null } else { s.bgHex = hex; s.bg = null }
        i += 2
      } else if (params[i + 1] === 2 && params[i + 4] != null) {
        const hex = `#${hex2(params[i + 2])}${hex2(params[i + 3])}${hex2(params[i + 4])}`
        if (isFg) { s.fgHex = hex; s.fg = null } else { s.bgHex = hex; s.bg = null }
        i += 4
      }
    }
  }
}

// collapseCr resolves bare carriage returns within each line (progress bars): a
// \r returns to column 0, so the last write wins. Approximated by keeping the
// text after the final \r on each line - enough to settle a progress spinner to
// its final frame without a full terminal grid.
function collapseCr(input: string): string {
  // PTYs use CRLF for ordinary newlines. Resolve that pair first so only a
  // remaining bare CR is treated as an in-place progress-line overwrite.
  return input.replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n')
}

// ansiToText is the plain-text counterpart to ansiToHtml: resolve terminal
// rewrites as well as removing escape sequences. Syntax highlighters use this
// when captured terminal output also has a fence language - feeding them the
// raw ESC bytes can derail the grammar for the rest of the block.
export function ansiToText(input: string): string {
  return stripAnsi(collapseCr(input))
}

// ansiToHtml converts SGR colour/style escapes to <span> HTML (palette classes
// styled per-theme in index.css, 8-bit/24-bit colours as inline styles), turns
// OSC 8 hyperlinks into <a> tags, and strips every other control sequence. Text
// is HTML-escaped, so the result is safe for innerHTML. This is the "render,
// don't strip" path for terminal output (bash tool results).
export function ansiToHtml(input: string): string {
  const text = collapseCr(input)
  const state = emptyState()
  let out = ''
  let buf = ''
  let link: string | null = null
  const flush = () => {
    if (!buf) return
    const cls = stateClasses(state)
    const style = stateStyle(state)
    const inner = escapeHtml(buf)
    const attrs = `${cls ? ` class="${cls}"` : ''}${style ? ` style="${style}"` : ''}`
    out += attrs ? `<span${attrs}>${inner}</span>` : inner
    buf = ''
  }
  const openLink = (href: string) => {
    flush()
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" class="ansi-link">`
    link = href
  }
  const closeLink = () => {
    flush()
    if (link != null) { out += '</a>'; link = null }
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== ESC && ch !== CSI) {
      buf += ch
      continue
    }
    flush()
    if (ch === CSI || text[i + 1] === '[') {
      // CSI: ESC[ (or the single-byte CSI) then params then a final byte.
      let j = ch === CSI ? i + 1 : i + 2
      const start = j
      while (j < text.length && /[\d;?]/.test(text[j])) j++
      if (text[j] === 'm') {
        const raw = text.slice(start, j).replace(/\?/g, '')
        const params = raw === '' ? [0] : raw.split(';').map((n) => parseInt(n, 10) || 0)
        applySgr(state, params)
      }
      // Non-SGR CSI (cursor moves, clear line, ...): dropped.
      i = j // the loop's ++ steps past the final byte
    } else if (text[i + 1] === ']') {
      // OSC: read to the ST (BEL or ESC\). OSC 8 is a hyperlink: `8;;<uri>`.
      let k = i + 2
      let payload = ''
      while (k < text.length && text[k] !== BEL && !(text[k] === ESC && text[k + 1] === '\\')) {
        payload += text[k]
        k++
      }
      const m = /^8;[^;]*;(.*)$/.exec(payload)
      if (m) {
        if (m[1]) openLink(m[1])
        else closeLink()
      }
      i = text[k] === ESC ? k + 1 : k
    } else {
      // Two-byte escape (charset select, etc.): skip the next byte.
      i = i + 1
    }
  }
  closeLink()
  flush()
  return out
}
