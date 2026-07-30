import type { ReactNode } from 'react'
import { renderMarkdownSource } from './markdown'

// Painting @agent / @review in a review comment box as you type.
//
// A mention decides who a comment wakes (docs/review-agent.md), so it has to be
// visible while you are writing it - a routing rule you cannot see until after you
// hit submit is a rule you will get wrong. This is the ONLY box that paints them:
// mentions mean nothing in the chat composer, and highlighting them there would
// promise a behaviour that does not exist.
//
// The pattern is kept deliberately identical to the server's
// (internal/reviewstore/mentions.go): a token the box paints but the daemon
// ignores - or the reverse - is worse than no highlighting at all, because it
// teaches you a rule that is not real.
const MENTION_RE = /(^|[^\w@/.-])(@(?:agent|head|review|reviewer))\b/g

// The two audiences are tinted differently on purpose. "Who did I just address"
// is the question, and one colour for both would answer it no better than the
// plain text does.
const TINT: Record<string, string> = {
  '@agent': 'text-amber-600 dark:text-amber-400',
  '@head': 'text-amber-600 dark:text-amber-400',
  '@review': 'text-violet-600 dark:text-violet-400',
  '@reviewer': 'text-violet-600 dark:text-violet-400',
}

// renderCommentMentions paints mentions in already-rendered comment prose. It
// deliberately changes colour only: the source backdrop and textarea must keep
// identical glyph widths, so changing weight here makes the caret and following
// text drift sideways.
export function renderCommentMentions(text: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(MENTION_RE)) {
    const at = (m.index ?? 0) + m[1].length
    if (at > last) out.push(text.slice(last, at))
    out.push(
      <span key={key++} className={TINT[m[2].toLowerCase()] ?? ''} data-review-mention="">
        {m[2]}
      </span>,
    )
    last = at + m[2].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length === 0 ? text : out
}

// renderCommentSource is HighlightedTextarea's backdrop for a review comment: the
// usual markdown source rendering, with mentions tinted on top.
//
// Split on the mention and hand each surrounding run to the normal renderer, so
// the backdrop stays character-for-character with the textarea (the whole trick
// this component rests on) and markdown still lights up around the mention.
export function renderCommentSource(text: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(MENTION_RE)) {
    const at = (m.index ?? 0) + m[1].length
    if (at > last) out.push(<span key={key++}>{renderMarkdownSource(text.slice(last, at))}</span>)
    out.push(
      <span key={key++} className={TINT[m[2].toLowerCase()] ?? ''}>
        {m[2]}
      </span>,
    )
    last = at + m[2].length
  }
  if (last < text.length) out.push(<span key={key}>{renderMarkdownSource(text.slice(last))}</span>)
  return out
}
