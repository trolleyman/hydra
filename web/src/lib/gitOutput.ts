// Colour what git prints about the repository - `git status`, `git status
// --short`, `git log`, `git log --oneline`, `git show --stat`, `git diff` -
// which otherwise reaches the chat card as a wall of terminal text with the one
// thing worth seeing in it (what changed, and in which direction) spelled
// entirely in punctuation.
//
// There is no grammar to point a highlighter at. Each of git's report lines has
// its own fixed shape, and shapes from what are really three different formats
// turn up inside one command's output (`git show --stat` prints a commit header,
// then a message, then a diffstat). So this classifies LINE BY LINE, in the
// colours git's own porcelain uses, and hands back anything that fits no shape
// exactly as it arrived.
//
// It is only ever given the output of a command lib/shellSections already
// recognised as one of those git calls, which is what makes shapes this loose
// safe to key on: `M web/src/x.tsx` means "modified" here and means nothing at
// all in the output of any other command.
import { IGNORE_TOKEN_CLASSES, ignoreTokens } from './ignoreHighlight'
import type { OutputSpan } from './outputSpan'

// The shape every function here returns - named for what it is a span OF, since
// this module is one of several that colour a tool's output (see lib/diskOutput).
export type GitSpan = OutputSpan

// The staged/unstaged split is the whole point of a status, so it gets the
// green/red pair the diff viewer uses. Everything git prints as scaffolding -
// labels, hints, the `|` in a diffstat - is dimmed so the paths read first.
const DIM = 'text-stone-400 dark:text-stone-500'
const ADD = 'text-green-600 dark:text-green-400'
const DEL = 'text-red-600 dark:text-red-400'
const SHA = 'text-amber-600 dark:text-amber-400'
const REF = 'text-sky-700 dark:text-sky-400'

// A diffstat row: ` web/src/x.tsx | 32 ++++++----`, ` img.png | Bin 0 -> 12 bytes`.
const STAT = /^( *)(\S.*?)( +\| +)(Bin .*?|\d+)( *)([+-]*)$/
// Its trailer: ` 8 files changed, 174 insertions(+), 43 deletions(-)`.
const SUMMARY = /^ *\d+ files? changed/
const SUMMARY_PARTS = /\d+ insertions?\(\+\)|\d+ deletions?\(-\)/g
// `commit 5d671ab0a7401035` / `tag v1.2`, optionally decorated with the refs
// pointing at it.
const COMMIT = /^(commit|tag) ([0-9a-f]{7,40})(.*)$/
// The rest of a commit header: `Author: ...`, `Date: ...`, `Merge: a1b2 c3d4`.
const HEADER = /^(Merge|Author|AuthorDate|Commit|CommitDate|Date|Reflog):( +)(.*)$/
// The address on an `Author:`/`Commit:` line. It is the same address on every
// commit an agent is looking at, so it is furniture next to the name.
const EMAIL = /^(.*?)( *<[^<>]*>)$/
// `git log --oneline`: a sha, the refs pointing at it when `--decorate` asked
// for them, then the subject.
const ONELINE = /^([0-9a-f]{7,40}) (\([^()]*\) )?(.+)$/
// What makes that parenthesised group a decoration rather than the opening word
// of the subject: it names a ref the way git writes them. `(HEAD -> main)`,
// `(origin/main)` and `(tag: v1.2)` are decorations; a subject that opens
// `(chore) bump deps` is not, and keeps its own colour.
const DECORATION = /HEAD|tag: |->|\//
// `git log --graph` draws the topology in the left margin with these, then
// prints the ordinary log line after it. At least one glyph is required, so the
// four spaces git indents a commit message by are not read as a margin.
const GRAPH = /^[*|\\/_ ]*[*|\\/_] */

// --- A patch ------------------------------------------------------------------
//
// The shapes below are only ever applied INSIDE one (see `patch` in
// gitOutputSpans), because a patch is the one part of git's output whose lines
// begin with characters that mean something else everywhere else in it: a `-`
// opens a deletion here and opens an option in a hint line two commands away.

// The file-header block, split by whether what follows the label is a path
// worth reading or a mode, a percentage or nothing.
const FILE_LABEL = /^(diff --git |rename from |rename to |copy from |copy to |Binary files )(.*)$/
const FILE_META = /^(old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|GIT binary patch)\b/
// `index 560e9b39..28c6f309 100644`.
const INDEX = /^(index )([0-9a-f]+\.\.[0-9a-f]+)( .*)?$/
// The two paths the hunks below are between.
const FILE_PATH = /^(--- |\+\+\+ )(.+)$/
// `@@ -556,7 +556,9 @@ func (m *Manager) RetractOrphanedTurn(...)`. A combined
// diff (a merge) writes one more `@` and one more range per parent.
const HUNK = /^(@@+[-+0-9, ]+@@+)(.*)$/
// The note git leaves when a file's last line has no newline. It is neither an
// addition nor a deletion, whichever side's `-`/`+` it follows.
const NO_NEWLINE = /^\\ No newline at end of file/
// `git status --short`: an index column, a worktree column, then the path.
const SHORT = /^([ MADRCUT?!])([ MADRCUT?!]) (\S.*)$/
// `git check-ignore -v`: which rule, in which file, on which line, decided a
// path - `web/.gitignore:9:iosevka-*.woff2\tweb/public/fonts/iosevka-400.woff2`.
// With `-n` the same shape carries an empty source for a path that is NOT
// ignored (`::\tpath`).
//
// The tab is what makes this safe to key on: nothing else git prints puts a
// `source:line:` in front of one.
const CHECK_IGNORE = /^([^\t:]*):(\d*):([^\t]*)\t(.*)$/
// `git branch -vv`: the current branch's marker, its name, the sha at its tip,
// what it tracks, and the subject of that commit.
const BRANCH_ROW = /^([* +]\s*)(\S+)(\s+)([0-9a-f]{7,40})(\s+)(\[[^\]]*\]\s+)?(.*)$/
// A worktree's branch is printed in parentheses instead of being checked out.
const BRANCH_DETACHED = /^([* +]\s*)(\([^)]*\))(\s+)([0-9a-f]{7,40})(\s+)(.*)$/
// `git remote -v`: a name, a URL, and which direction it is used in.
const REMOTE_ROW = /^(\S+)(\s+)(\S+)(\s+\((?:fetch|push)\))$/
// `git stash list`: `stash@{0}: WIP on main: a7401035 subject`.
const STASH_ROW = /^(stash@\{\d+\})(: )(.*)$/
// `git shortlog -sn`: how many commits, then who. The tab is required - a
// commit message body that opens with a number is not a shortlog row.
const SHORTLOG_ROW = /^(\s*)(\d+)(\t)(.*)$/

// The long status's own furniture.
const BRANCH = /^(On branch |HEAD detached at |HEAD detached from )(.*)$/
const SECTION = /^(Changes to be committed|Changes not staged for commit|Untracked files|Unmerged paths|Ignored files|Changes staged for commit):$/
const HINT = /^ *\(.*\)$/
const TRAILER = /^(Your branch |nothing to commit|nothing added to commit|no changes added to commit|Untracked files not listed|It took )/
// An entry under one of those headings: `\tmodified:   web/src/x.tsx`. The
// label runs to the colon, and can be two words (`both modified`, `added by us`).
const ENTRY = /^(\t)([a-z][a-z ]*:)( *)(.*)$/
// An untracked or unmerged path, which is printed with no label at all.
const BARE_ENTRY = /^(\t)(\S.*)$/

// The `?` and `!` columns say "git is not tracking this", which is neither an
// addition nor a deletion - the red git paints them is louder than they are.
function columnClass(code: string, side: string): string {
  if (code === ' ') return ''
  return code === '?' || code === '!' ? DIM : side
}

// checkIgnoreSpans colours one line of a `git check-ignore -v`: where the rule
// lives, the rule itself, and the path it was asked about.
//
// The two things worth reading are the rule and the path it caught, so both keep
// the panel's colour and only the `source:line:` in front of them dims - the
// same split the diffstat draws between a path and its `|`. Inside the rule the
// machinery is marked in the ignore file's own colours (lib/ignoreHighlight), so
// a `*` reads as a wildcard here exactly as it does in the .gitignore it was
// quoted out of.
function checkIgnoreSpans(source: string, num: string, pattern: string, path: string): GitSpan[] {
  return [
    { text: `${source}:${num}:`, cls: DIM },
    ...ignoreTokens(pattern).map((t) => ({ text: t.text, cls: IGNORE_TOKEN_CLASSES[t.kind] })),
    { text: '\t', cls: '' },
    { text: path, cls: '' },
  ]
}

// A rename is printed as one path: `R  old/name -> new/name`.
function pathSpans(path: string): GitSpan[] {
  const at = path.indexOf(' -> ')
  if (at < 0) return [{ text: path, cls: '' }]
  return [
    { text: path.slice(0, at), cls: DIM },
    { text: ' -> ', cls: DIM },
    { text: path.slice(at + 4), cls: '' },
  ]
}

// startsPatch reports whether a line opens a patch, so that everything after it
// is read as one. `diff --git` is the usual answer; the other two are there for
// output that arrives already cut into (`git diff | tail -20`, a fragment quoted
// back by another tool).
function startsPatch(line: string): boolean {
  return FILE_LABEL.test(line) || FILE_META.test(line) || HUNK.test(line) || FILE_PATH.test(line)
}

// patchSpans colours one line of a patch. Every line gets an answer - a patch
// has no gaps in it, and a context line falling through to the report shapes
// below would have its leading space read as a status column.
function patchSpans(line: string): GitSpan[] {
  const index = INDEX.exec(line)
  if (index) return [{ text: index[1], cls: DIM }, { text: index[2], cls: SHA }, { text: index[3] ?? '', cls: DIM }]

  // The paths are the one part of the header block worth reading, so they keep
  // the panel's own colour while the rest of the line recedes. `/dev/null` is
  // not a path anyone is looking for.
  const path = FILE_PATH.exec(line)
  if (path) return [{ text: path[1], cls: DIM }, { text: path[2], cls: path[2] === '/dev/null' ? DIM : '' }]

  const label = FILE_LABEL.exec(line)
  if (label) return [{ text: label[1], cls: DIM }, { text: label[2], cls: '' }]
  if (FILE_META.test(line)) return [{ text: line, cls: DIM }]

  // The ranges say where in the file this is, which is what the header is for;
  // the enclosing function git repeats after them is orientation, not content.
  const hunk = HUNK.exec(line)
  if (hunk) return [{ text: hunk[1], cls: REF }, { text: hunk[2], cls: DIM }]

  if (NO_NEWLINE.test(line)) return [{ text: line, cls: DIM }]

  if (line.startsWith('+')) return [{ text: line, cls: ADD }]
  if (line.startsWith('-')) return [{ text: line, cls: DEL }]
  return [{ text: line, cls: '' }]
}

// shapeSpans colours one line, or returns null when it fits no shape. `staged`
// is what the last section heading said, so that a long status paints the same
// path green above "Changes not staged for commit:" and red below it - which is
// the distinction the whole command exists to draw.
function shapeSpans(line: string, staged: boolean): GitSpan[] | null {
  // Asked first: it is the most specific shape here (a `source:line:` AND a
  // tab), and its pattern column can hold anything - including text that would
  // otherwise read as a diffstat row.
  const ignored = CHECK_IGNORE.exec(line)
  if (ignored) return checkIgnoreSpans(ignored[1], ignored[2], ignored[3], ignored[4])

  const stat = STAT.exec(line)
  if (stat) {
    const [, indent, path, bar, count, gap, graph] = stat
    return [
      { text: indent, cls: '' },
      ...pathSpans(path),
      { text: bar, cls: DIM },
      { text: count, cls: DIM },
      { text: gap, cls: '' },
      // git prints every `+` then every `-`, but colouring runs rather than
      // assuming that costs nothing.
      ...(graph.match(/\++|-+/g) ?? []).map((run) => ({ text: run, cls: run[0] === '+' ? ADD : DEL })),
    ]
  }

  if (SUMMARY.test(line)) {
    const spans: GitSpan[] = []
    let at = 0
    for (const part of line.matchAll(SUMMARY_PARTS)) {
      spans.push({ text: line.slice(at, part.index), cls: DIM })
      spans.push({ text: part[0], cls: part[0].includes('+') ? ADD : DEL })
      at = part.index + part[0].length
    }
    spans.push({ text: line.slice(at), cls: DIM })
    return spans
  }

  const commit = COMMIT.exec(line)
  if (commit) {
    return [
      { text: `${commit[1]} `, cls: DIM },
      { text: commit[2], cls: SHA },
      { text: commit[3], cls: REF },
    ]
  }

  const header = HEADER.exec(line)
  if (header) {
    const label = [{ text: `${header[1]}:`, cls: DIM }, { text: header[2], cls: '' }]
    if (header[1] === 'Merge') return [...label, { text: header[3], cls: SHA }]
    const email = EMAIL.exec(header[3])
    if (email) return [...label, { text: email[1], cls: '' }, { text: email[2], cls: DIM }]
    return [...label, { text: header[3], cls: '' }]
  }

  const branch = BRANCH.exec(line)
  if (branch) return [{ text: branch[1], cls: DIM }, { text: branch[2], cls: REF }]

  if (SECTION.test(line)) return [{ text: line, cls: '' }]
  if (HINT.test(line) || TRAILER.test(line)) return [{ text: line, cls: DIM }]

  const entry = ENTRY.exec(line)
  if (entry) {
    const side = staged ? ADD : DEL
    return [
      { text: entry[1], cls: '' },
      { text: entry[2], cls: side },
      { text: entry[3], cls: '' },
      ...pathSpans(entry[4]).map((s) => ({ ...s, cls: s.cls || side })),
    ]
  }

  const bare = BARE_ENTRY.exec(line)
  if (bare) {
    const side = staged ? ADD : DEL
    return [{ text: bare[1], cls: '' }, ...pathSpans(bare[2]).map((s) => ({ ...s, cls: s.cls || side }))]
  }

  // `git branch -vv`. Only for a line that opens with the column git reserves
  // for the `*`, which is what keeps a commit message two spaces in from being
  // read as a branch row.
  if (/^[* +] /.test(line)) {
    const row = BRANCH_ROW.exec(line)
    const detached = row ? null : BRANCH_DETACHED.exec(line)
    const m = row ?? detached
    if (m) {
      const current = line.startsWith('*')
      // The `*` says which branch you are ON, which is the question the command
      // is usually asked; the name beside it reads as loud as the marker. The
      // upstream (`[origin/main: ahead 2]`) and the subject are context for the
      // row, not the row.
      return [
        { text: m[1], cls: current ? REF : DIM },
        { text: m[2], cls: current ? REF : '' },
        { text: m[3], cls: '' },
        { text: m[4], cls: SHA },
        { text: m[5], cls: '' },
        { text: row ? `${row[6] ?? ''}${row[7]}` : m[6], cls: DIM },
      ]
    }
  }

  const remote = REMOTE_ROW.exec(line)
  if (remote) {
    return [
      { text: remote[1], cls: REF },
      { text: remote[2], cls: '' },
      { text: remote[3], cls: '' },
      { text: remote[4], cls: DIM },
    ]
  }

  const stash = STASH_ROW.exec(line)
  if (stash) {
    const rest = stash[3]
    const sha = /^(.*?)([0-9a-f]{7,40})(\s.*)?$/.exec(rest)
    return [
      { text: stash[1], cls: REF },
      { text: stash[2], cls: DIM },
      ...(sha
        ? [{ text: sha[1], cls: DIM }, { text: sha[2], cls: SHA }, { text: sha[3] ?? '', cls: '' }]
        : [{ text: rest, cls: '' }]),
    ]
  }

  const shortlog = SHORTLOG_ROW.exec(line)
  if (shortlog) {
    return [
      { text: shortlog[1], cls: '' },
      { text: shortlog[2], cls: SHA },
      { text: shortlog[3], cls: '' },
      { text: shortlog[4], cls: '' },
    ]
  }

  const short = SHORT.exec(line)
  // Both columns blank is not a status line - it is an indented line of a commit
  // message that happens to be three characters in.
  if (short && (short[1] !== ' ' || short[2] !== ' ')) {
    return [
      { text: short[1], cls: columnClass(short[1], ADD) },
      { text: short[2], cls: columnClass(short[2], DEL) },
      { text: ' ', cls: '' },
      ...pathSpans(short[3]),
    ]
  }

  const oneline = ONELINE.exec(line)
  if (oneline) {
    const decoration = oneline[2] && DECORATION.test(oneline[2]) ? oneline[2] : ''
    return [
      { text: oneline[1], cls: SHA },
      { text: ' ', cls: '' },
      { text: decoration, cls: REF },
      { text: `${decoration ? '' : (oneline[2] ?? '')}${oneline[3]}`, cls: '' },
    ]
  }

  return null
}

// lineSpans colours one line, falling back to the line as it arrived.
//
// A `--graph` margin is peeled off first and dimmed, then the rest of the line
// is classified as the ordinary log line it is - but only when that rest turns
// out to HAVE a shape, so a commit message whose body is a bulleted list keeps
// its `*` rather than having it read as a graph edge.
function lineSpans(line: string, staged: boolean, patch: boolean): GitSpan[] {
  if (patch) return patchSpans(line)

  const shaped = shapeSpans(line, staged)
  if (shaped) return shaped

  const graph = GRAPH.exec(line)
  if (graph) {
    const rest = line.slice(graph[0].length)
    // A line that is nothing but margin (`|\`, `|/`) draws an edge and says
    // nothing else, so there is no remainder to ask about.
    const inner = rest === '' ? [] : shapeSpans(rest, staged)
    if (inner) return [{ text: graph[0], cls: DIM }, ...inner]
  }

  return [{ text: line, cls: '' }]
}

// gitOutputSpans colours a whole git report, one span list per line.
export function gitOutputSpans(lines: string[]): GitSpan[][] {
  // "Changes to be committed:" is the only heading whose entries are staged;
  // everything under any other one - and anything before the first heading -
  // is not.
  let staged = false
  // Whether we are inside a patch. It latches on at the first thing that opens
  // one and off at the next commit header, which is how a `git log -p` reads:
  // header, message, patch, header, message, patch. Nothing else turns it off -
  // a patch runs to the end of the output it is the last thing in.
  let patch = false
  return lines.map((line) => {
    if (SECTION.test(line)) staged = line.startsWith('Changes to be committed')
    if (COMMIT.test(line)) patch = false
    else if (!patch && startsPatch(line)) patch = true
    return lineSpans(line, staged, patch).filter((s) => s.text !== '')
  })
}

// --- A blame -------------------------------------------------------------------

// One line of `git blame`: which commit last touched it, who and when, its
// number in the file, and the line itself.
export interface BlameLine {
  sha: string
  // Everything between the sha and the line number - the author and the date,
  // which are context rather than content.
  meta: string
  num: string
  code: string
}

// `a7401035 (Callum Tolley 2026-07-29 16:57:41 +0100  12) func main() {`, with a
// `^` in front of a sha that is a boundary commit and an optional path between
// the sha and the parenthesis when blame followed the file across a rename.
const BLAME_LINE = /^(\^?[0-9a-f]{7,40})\s(.*?)\((.*?)\s+(\d+)\)(?: (.*))?$/

// parseBlameLine reads that shape, or null for a line that is not one - which is
// how a `fatal:` on stderr, or a format this does not know, stays plain text.
export function parseBlameLine(line: string): BlameLine | null {
  const m = BLAME_LINE.exec(line)
  if (!m) return null
  return { sha: m[1], meta: `${m[2]}(${m[3]}`, num: m[4], code: m[5] ?? '' }
}

// blamePrefixSpans colours what blame writes IN FRONT of each line: the commit,
// then who and when. The sha is the one part worth reading - it is what you take
// to `git show` next - so it keeps the colour a sha has everywhere else here and
// the rest recedes.
export function blamePrefixSpans(blame: BlameLine): GitSpan[] {
  return [
    { text: blame.sha, cls: SHA },
    { text: ` ${blame.meta} ${blame.num})`, cls: DIM },
  ]
}
