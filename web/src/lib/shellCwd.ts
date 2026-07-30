// Follow an agent's working directory across the commands it runs.
//
// An agent's Bash tool is ONE persistent shell for the whole session, so a `cd`
// in step 3 is still in force at step 40 - which is why `cd web && node x.ts`
// fails with "cd: web: No such file or directory" when the shell is already in
// web/. The tool call records only the command, never the directory it ran in,
// so the chat has to reconstruct it: start at the worktree, apply the `cd`s each
// command performs, and hand every card the directory its command started in.
//
// Where the CLI records the directory itself, that wins: Claude writes a `cwd`
// on every transcript entry, and the one on a tool RESULT is exactly where the
// shell was left (the daemon relays it - internal/chat/claude.go). The walk
// below is the fallback for what that does not cover: live stdout lines on CLI
// versions that omit the field, and the first command of a conversation.
//
// It is deliberately a KNOWN-or-nothing tracker. Anything it cannot resolve - a
// `cd $DIR`, a `cd -`, a bare `cd` (which goes to $HOME, a path the browser does
// not know) - makes the directory UNKNOWN rather than a guess, and it stays
// unknown until something re-anchors it: an absolute `cd /path`, or a provider
// that reports the cwd itself (Codex does; Claude does not). A wrong directory
// shown as fact is worse than none, and agents re-anchor constantly - the
// defensive `cd <the worktree> && ...` prefix they open scripts with is exactly
// that.
import { topLevelStatements, unwrapBashLoginCommand } from './bashFormat'

// How the tool carries the directory forward, measured against Claude Code's
// Bash tool rather than assumed (each row was run and the next command's `pwd`
// read back):
//
//   cd web/src        then  pwd  ->  <root>/web/src      persists
//   cd lib            then  pwd  ->  <root>/web/src/lib  relative to the last one
//   cd web/src; false then  pwd  ->  <root>              a FAILED command moves nothing
//   cd lib; exit 0    then  pwd  ->  <root>/web/src      an early exit moves nothing
//   cd /tmp           then  pwd  ->  <root>              plus "Shell cwd was reset to <root>"
//   (cd ..; pwd)      then  pwd  ->  unchanged           a subshell never escapes
//
// So it is not "wherever the script ended up": the directory is captured only
// when the script runs to completion with status 0, and only while it stays
// inside the directory the agent started in. Both rules are applied below.
// A `cd` that failed - the shell stayed where it was. Bash reports it through
// whatever wrapper it was launched from ("<snapshot>.sh: line 53: cd: web: No
// such file or directory"), so the message is matched, not the line prefix.
// Still needed alongside the exit-status rule: `cd nope; echo ok` ends with
// status 0, so the directory IS captured - just not where the `cd` asked for.
const CD_FAILED = /\bcd: (?:[^\n:]*: )?[^\n]*: (?:No such file or directory|Not a directory|Permission denied)/

// What a statement does to the working directory.
type CdTarget =
  | { kind: 'none' } // not a cd
  | { kind: 'unknown' } // a cd we cannot resolve
  | { kind: 'path'; path: string }

const NOT_A_CD: CdTarget = { kind: 'none' }
const UNRESOLVABLE: CdTarget = { kind: 'unknown' }

// Keywords that can precede a command inside a compound statement, so
// `do cd web` is still recognised as the `cd` it is.
const LEADING_KEYWORD = /^(?:do|then|else|\{|!)\s+/

// firstWord pulls the first shell word of `rest`, unquoting it. Returns null for
// a word whose value depends on the shell (an expansion, a glob, a `~` we cannot
// expand without knowing $HOME).
function firstWord(rest: string): string | null {
  let out = ''
  let quote: "'" | '"' | null = null
  let expanded = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === '\\' && quote !== "'") {
      if (i + 1 >= rest.length) break
      out += rest[++i]
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else {
        if (quote === '"' && (ch === '$' || ch === '`')) expanded = true
        out += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) break
    // A redirection ends the word list; anything after it is not an argument.
    if (ch === '<' || ch === '>') break
    if (ch === '$' || ch === '`' || ch === '*' || ch === '?') expanded = true
    if (ch === '~' && out === '') expanded = true
    out += ch
  }
  return expanded || !out ? null : out
}

// cdTarget reads what one top-level statement changes the directory to.
function cdTarget(statement: string): CdTarget {
  let s = statement
  for (;;) {
    const stripped = s.replace(LEADING_KEYWORD, '')
    if (stripped === s) break
    s = stripped
  }
  if (!/^cd(?:\s|$)/.test(s)) return NOT_A_CD
  // `cd` alone goes to $HOME, and `cd -` to wherever the shell was before - the
  // transcript does not say where either of those is.
  let rest = s.slice(2).trim()
  while (/^(?:-[LP]+|--)(?:\s|$)/.test(rest)) rest = rest.replace(/^\S+\s*/, '')
  if (!rest || rest.startsWith('-')) return UNRESOLVABLE
  const word = firstWord(rest)
  return word === null ? UNRESOLVABLE : { kind: 'path', path: word }
}

// normalize resolves `.` and `..` in an absolute path, without touching the
// filesystem (a symlinked path resolves the way `cd` itself would, textually).
function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

// resolveCwd applies one `cd <path>` to the directory it runs in.
export function resolveCwd(base: string, target: string): string {
  return normalize(target.startsWith('/') ? target : `${base}/${target}`)
}

// One Bash tool call, in the order the agent made it.
export interface ShellStep {
  // The tool_use id, which the result maps back to.
  id: string
  // The command as the agent wrote it (before any display formatting).
  command: string
  // The directory the provider itself reported for this call, when it reports
  // one at all (Codex does). Authoritative: it beats anything tracked.
  cwd?: string
  // The directory recorded on this command's RESULT, i.e. where the shell was
  // left afterwards (Claude writes it on every transcript entry - see
  // internal/chat/claude.go). Ground truth, so it replaces whatever the walk
  // below worked out, and the next command inherits it. Absent on live stdout
  // from some CLI versions, which is what the walk is for.
  cwdAfter?: string
  // The command's output, read only to spot a `cd` that failed.
  output?: string
  // The command exited non-zero (or never ran at all - denied, timed out): its
  // directory is never captured, so none of its `cd`s outlive it.
  failed?: boolean
  // No result ever came back: the turn was interrupted, or the agent process
  // stopped mid-command and was resumed. How far down the script the shell got
  // is unknowable, and a resume starts a NEW shell back at the worktree, so
  // neither the directory the command was in nor the one its `cd`s asked for
  // survives it. Without this the walk applies the whole script anyway: the
  // trailing `cd web` of a command killed during its `sleep` moved the tracked
  // directory into web/ while the real shell restarted at the worktree, and
  // every command after it was captioned one level too deep (`cd web/web`).
  unfinished?: boolean
  // A backgrounded command runs in its own shell, so its `cd`s do not outlive it.
  background?: boolean
}

// trackShellCwds returns, per step id, the absolute directory that step's
// command STARTED in - null when the shell's directory is not known at that
// point. `worktree` is where the session's shell starts.
export function trackShellCwds(steps: ShellStep[], worktree: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const root = worktree ? normalize(worktree) : null
  let current: string | null = root
  for (const step of steps) {
    const reported = step.cwd && step.cwd !== '.' ? normalize(step.cwd) : ''
    const entry = reported || current
    out.set(step.id, entry)
    // Where the CLI itself says the shell was left. Nothing below can improve on
    // that, so the walk is skipped entirely.
    if (step.cwdAfter) {
      current = normalize(step.cwdAfter)
      continue
    }
    if (step.background) continue
    // A command that never came back says nothing about where it left the shell
    // (see `unfinished`), so the directory goes unknown until something
    // re-anchors it - an absolute `cd`, or a provider that reports its own cwd.
    if (step.unfinished) {
      current = null
      continue
    }
    // A command that did not finish successfully never had its directory
    // captured, so it moved nothing - not even the `cd` that succeeded before
    // the failure. `cd web && bun test` with failing tests leaves the shell
    // exactly where it was.
    if (step.failed) {
      current = entry
      continue
    }
    // A failed `cd` in a command that still exited 0 (`cd nope; echo ok`) is the
    // same story for that one statement.
    if (step.output && CD_FAILED.test(step.output)) {
      current = entry
      continue
    }
    let at: string | null = entry
    for (const statement of topLevelStatements(unwrapBashLoginCommand(step.command))) {
      const target = cdTarget(statement)
      if (target.kind === 'none') continue
      if (target.kind === 'unknown') {
        at = null
        continue
      }
      // A relative `cd` from an unknown directory lands somewhere unknown; an
      // absolute one re-anchors the tracking.
      at = target.path.startsWith('/') ? normalize(target.path) : at ? resolveCwd(at, target.path) : null
    }
    // Wandering outside the directory the agent started in does not stick: the
    // tool resets it ("Shell cwd was reset to <root>") the moment the command
    // ends. Only for a directory we tracked ourselves - a provider that reports
    // its own cwd is telling us where the command really ran, and will report
    // the next one too.
    const escaped = !reported && root && at && !(at === root || at.startsWith(root + '/'))
    current = escaped ? root : at
  }
  return out
}
