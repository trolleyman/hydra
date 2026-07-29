// Colour the reports git prints about the repository - `git status`, `git status
// --short`, `git log`, `git log --oneline`, `git show --stat` - which otherwise
// reach the chat card as a wall of terminal text with the one thing worth seeing
// in them (what changed, and in which direction) spelled entirely in
// punctuation.
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

export interface GitSpan {
  text: string
  // Tailwind classes to colour the text with; '' takes the panel's own colour.
  cls: string
}

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
// `git status --short`: an index column, a worktree column, then the path.
const SHORT = /^([ MADRCUT?!])([ MADRCUT?!]) (\S.*)$/
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

// shapeSpans colours one line, or returns null when it fits no shape. `staged`
// is what the last section heading said, so that a long status paints the same
// path green above "Changes not staged for commit:" and red below it - which is
// the distinction the whole command exists to draw.
function shapeSpans(line: string, staged: boolean): GitSpan[] | null {
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
function lineSpans(line: string, staged: boolean): GitSpan[] {
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
  return lines.map((line) => {
    if (SECTION.test(line)) staged = line.startsWith('Changes to be committed')
    return lineSpans(line, staged).filter((s) => s.text !== '')
  })
}
