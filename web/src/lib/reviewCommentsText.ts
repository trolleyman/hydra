// Parsing the text `get_review_comments` returns, so the chat can render the
// comments as comments rather than as the flat transcript an agent reads.
//
// The producer is `reviewstore.RenderForAgent` (Go). Its shape per comment is:
//
//   #19 internal/cli/runtime.go:585 (reply to #12) [resolved] - user, on main -> latest commit
//   ```diff
//   --- internal/cli/runtime.go
//   ...
//   ```
//   What is this and why does it need a new path btw?
//
// with a blank line between comments. Everything after the number is optional
// except the author, which is always printed - which is what makes the header
// safe to recognise: a body line that happens to start "#20 fixed" has no
// " - <author>" and so stays body text.
//
// Two rules this module holds to, both because it is parsing text written for a
// model and not a wire format:
//
//   - It never half-parses. A text that yields no comment at all returns null and
//     the caller renders the raw text as markdown, exactly as before. A card that
//     silently dropped a paragraph would be worse than a plain one.
//   - It never drops characters. Every line of the input lands in a preamble, a
//     comment (header fields, context or body) or the trailer.

export interface ParsedReviewComment {
  number: number
  /** Repo-relative path the comment is anchored to, or '' for an unanchored one. */
  path: string
  /** Line within that file, or 0 when the anchor names only a file. */
  line: number
  /** The comment this one answers, or 0. */
  replyTo: number
  resolved: boolean
  /** 'user' | 'reviewer' | 'agent' - who wrote it. */
  author: string
  /** The comparison it was written against ("main -> latest commit"), or ''. */
  diff: string
  /** The frozen ```diff excerpt around the anchor, fence stripped, or ''. */
  context: string
  body: string
}

export interface ParsedReviewComments {
  /** Markdown before the first comment (the "Review comments left in Hydra:" heading). */
  preamble: string
  comments: ParsedReviewComment[]
  /** Markdown after the last comment - the forge half of a linked head's review. */
  trailer: string
}

const HEADER_RE =
  /^#(\d+)(?: (\S+?)(?::(\d+))?)?(?: \(reply to #(\d+)\))?( \[resolved\])? - ([^,]+?)(?:, on (.+))?$/

// A header only counts at the start of the text or after a blank line - the
// separator RenderForAgent puts between comments. Inside a body, a line of the
// same shape is prose someone wrote.
function isHeaderLine(lines: string[], i: number): boolean {
  if (!HEADER_RE.test(lines[i])) return false
  return i === 0 || lines[i - 1].trim() === ''
}

// The forge half is appended after a markdown rule. Splitting on it keeps a
// linked head's PR discussions out of the last Hydra comment's body.
//
// Only ever applied to a text that HAS a preamble: the rule and the heading are
// written together (`"Review comments left in Hydra:\n\n" + hydra + "\n\n---\n\n"
// + forge`), so without the heading a rule is markdown someone typed, and cutting
// the body at it would silently swallow the rest of what they said.
function splitTrailer(block: string[]): { body: string[]; trailer: string[] } {
  for (let i = 1; i < block.length; i++) {
    if (block[i].trim() === '---' && block[i - 1].trim() === '') {
      return { body: block.slice(0, i - 1), trailer: block.slice(i + 1) }
    }
  }
  return { body: block, trailer: [] }
}

// The frozen context is a fenced block at the top of a comment. Only there: a
// fence further down is markdown in the body and belongs to it.
function takeContext(block: string[]): { context: string; rest: string[] } {
  if (!block[0]?.startsWith('```')) return { context: '', rest: block }
  const close = block.findIndex((l, i) => i > 0 && l.trim() === '```')
  if (close < 0) return { context: '', rest: block }
  return { context: block.slice(1, close).join('\n'), rest: block.slice(close + 1) }
}

export function parseReviewCommentsText(text: string): ParsedReviewComments | null {
  const lines = text.split('\n')
  const starts = lines.flatMap((_, i) => (isHeaderLine(lines, i) ? [i] : []))
  if (starts.length === 0) return null

  const preamble = lines.slice(0, starts[0]).join('\n').trim()
  const comments: ParsedReviewComment[] = []
  let trailer: string[] = []
  starts.forEach((start, i) => {
    const m = HEADER_RE.exec(lines[start])!
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length
    const block = lines.slice(start + 1, end)
    // Only the LAST comment can be followed by the forge half; a rule inside any
    // other body is markdown the author wrote.
    const split = i + 1 === starts.length && preamble !== '' ? splitTrailer(block) : { body: block, trailer: [] }
    trailer = split.trailer
    const { context, rest } = takeContext(split.body)
    comments.push({
      number: Number(m[1]),
      path: m[2] ?? '',
      line: m[3] ? Number(m[3]) : 0,
      replyTo: m[4] ? Number(m[4]) : 0,
      resolved: m[5] != null,
      author: m[6],
      diff: m[7] ?? '',
      context,
      body: rest.join('\n').trim(),
    })
  })
  return { preamble, comments, trailer: trailer.join('\n').trim() }
}

// The number Hydra assigned to a comment an agent just wrote, taken from the
// tool's own confirmation ("Saved as #20, threaded under #19."). It is the only
// place that number exists - the tool call itself cannot know it - and it is what
// lets the card carry the same handle as the comment it created.
export function savedCommentNumber(result: string): number {
  const m = /^Saved as #(\d+)\b/.exec(result.trim())
  return m ? Number(m[1]) : 0
}
