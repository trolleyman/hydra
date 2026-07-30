// The queued/"Add to review" comments, backed by the SERVER rather than by
// localStorage (docs/review-agent.md).
//
// They used to live in a per-browser sharded store, which had two problems worth
// naming because they are why this module exists. A draft died on a reload and
// never left the browser it was typed in - so half a review, written on a laptop,
// was simply gone. And when it was finally submitted it was formatted into a
// markdown blob and pasted into the agent's transcript, where it could not be
// re-read, re-anchored, or survive a compaction; there was nothing left to point
// at afterwards, which is why "is #3 fixed?" was not a question anyone could ask.
//
// Now a comment is a durable, numbered object on the daemon. Publishing sends the
// agent one short line of numbers and locations, and the agent pulls the bodies
// with a tool.
//
// The in-progress line/thread drafts (the text you are part-way through typing,
// before "Add to review") deliberately stay in localStorage - see reviewDrafts.ts.
// Those are keystroke-frequency and pre-commitment; a round trip per keystroke
// would be absurd, and nothing else ever needs to see them.

import { api } from '../stores/apiClient'
import type { ReviewComment, ReviewImageAnchor } from '../api'

// One queued comment, in the shape the diff viewer renders.
//
// `number` is the durable handle ("#4") and doubles as the id; everything else is
// the frozen anchor. Deliberately the same field names the localStorage version
// used, so the rendering path did not have to change with the storage.
export interface PendingReviewComment {
  /**
   * The number as a string, because it is used as a React key and passed through
   * the memo'd hunk tree as an opaque handle. `number` below is the same value
   * for the API calls; keeping both means the rendering path did not have to
   * learn a new type when the storage changed under it.
   */
  id: string
  /** Per-head number, rendered "#4". Never reused, so it is a stable key. */
  number: number
  path: string
  lineNum: number
  isNew: boolean
  text: string
  fromLabel: string
  toLabel: string
  contextBlock: string
  hunkHash: string
  /** "user" | "reviewer" | "agent" - shown on a published comment that isn't yours. */
  author: string
  published: boolean
  /** Dealt with. A published comment that is resolved drops out of the open list. */
  resolved: boolean
  /** Seen by the user. Set only by an explicit mark-read. */
  read: boolean
  /** The comment this answers, which is how a thread forms without a thread object. */
  replyTo: number
  createdAt: number
  /** Set when the comment is pinned to a POINT ON A PICTURE (an artifact) rather
   *  than a line of the diff. The two are mutually exclusive in practice: an image
   *  comment has no path or line to render in the gutter, and is drawn on the
   *  picture in the lightbox instead. */
  image?: ReviewImageAnchor
}

// The anchor a new comment carries. `diff` is the comparison it was written
// against, resolved to concrete refs at add time so "latest commit" cannot drift
// between writing and publishing.
export interface NewComment {
  path: string
  lineNum: number
  isNew: boolean
  text: string
  fromLabel: string
  toLabel: string
  contextBlock: string
  hunkHash: string
}

function toPending(c: ReviewComment): PendingReviewComment {
  const [fromLabel = '', toLabel = ''] = (c.diff ?? '').split(' -> ')
  return {
    id: String(c.number),
    number: c.number,
    path: c.path ?? '',
    lineNum: c.line ?? 0,
    isNew: !c.old_side,
    text: c.body,
    fromLabel,
    toLabel,
    contextBlock: c.context ?? '',
    hunkHash: c.hunk_hash ?? '',
    author: c.author,
    published: c.status === 'published',
    resolved: !!c.resolved,
    read: !!c.read,
    replyTo: c.reply_to ?? 0,
    createdAt: Date.parse(c.created_at) || 0,
    image: c.image,
  }
}

// Every comment, drafts and published alike. The diff viewer renders both in the
// gutter - a comment an agent left is worth nothing if you cannot see it - but
// only the drafts drive the queued-comment popover and the submit count, since a
// published comment has left and the server refuses to edit or delete it.
function all(res: { comments: ReviewComment[] }): PendingReviewComment[] {
  return res.comments.map(toPending)
}

// Who "you" is on this machine, from git's user.name. Hydra has no accounts and
// hosts no pictures, so a comment you wrote is drawn as a monogram of this. The
// server sends it with every comments response, so it needs no fetch of its own.
export function youFrom(res: { you?: string }): string {
  return res.you ?? ''
}

/** The unpublished subset: what "Submit review" would send. */
export function draftsOf(comments: PendingReviewComment[]): PendingReviewComment[] {
  return comments.filter((c) => !c.published)
}

export async function fetchReviewComments(
  projectId: string | null,
  agentId: string,
): Promise<{ comments: PendingReviewComment[]; you: string }> {
  if (!projectId) return { comments: [], you: '' }
  const res = await api.default.getReviewComments(projectId, agentId)
  return { comments: all(res), you: youFrom(res) }
}

export async function addReviewComment(
  projectId: string | null,
  agentId: string,
  c: NewComment,
): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(
    await api.default.addReviewComment(projectId, agentId, {
      body: c.text,
      path: c.path,
      line: c.lineNum,
      old_side: !c.isNew,
      diff: `${c.fromLabel} -> ${c.toLabel}`,
      context: c.contextBlock,
      hunk_hash: c.hunkHash,
    }),
  )
}

// A comment pinned to a point on a picture rather than to a line of code.
//
// Its own function rather than a widened NewComment: an image comment has no
// path, line or hunk hash, and passing four empty strings through the line-comment
// shape would put a comment in the store that claims to be anchored to a file it
// says nothing about. `diffLabel` is the comparison it was written on, in the same
// "before -> after" form the line comments use, so both read the same way when an
// agent is told when the observation was made.
export async function addImageComment(
  projectId: string | null,
  agentId: string,
  c: { image: ReviewImageAnchor; text: string; diffLabel?: string; publish?: boolean },
): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(
    await api.default.addReviewComment(projectId, agentId, {
      body: c.text,
      image: c.image,
      diff: c.diffLabel,
      publish: c.publish,
    }),
  )
}

export async function updateReviewComment(
  projectId: string | null,
  agentId: string,
  number: number,
  text: string,
): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(await api.default.updateReviewComment(projectId, agentId, number, { body: text }))
}

export async function removeReviewComment(
  projectId: string | null,
  agentId: string,
  number: number,
): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(await api.default.deleteReviewComment(projectId, agentId, number))
}

// Publish every draft. The agent is notified server-side with one line of
// numbers - the browser never formats the message, which is the point: there is
// no second copy of the comment to drift from the first.
export async function publishReviewComments(
  projectId: string | null,
  agentId: string,
  numbers: number[] = [],
): Promise<{ comments: PendingReviewComment[]; notified: string | null }> {
  if (!projectId) return { comments: [], notified: null }
  const res = await api.default.publishReviewComments(projectId, agentId, { numbers })
  return { comments: all(res), notified: res.notified ?? null }
}

// Resolve (or reopen) a comment by number. Works for a forge comment too - the
// numbering is one sequence, so from here it is the same call - and resolving a
// forge thread is local to Hydra (see the API description).
export async function resolveReviewComment(
  projectId: string | null,
  agentId: string,
  number: number,
  resolved: boolean,
): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(await api.default.resolveReviewComment(projectId, agentId, number, { resolved }))
}

// Record that the user has seen these numbers (empty = all of them), or put them
// back to unread - "seen it, come back to it", the only way a comment becomes new
// again.
export async function markReviewCommentsRead(
  projectId: string | null,
  agentId: string,
  numbers: number[],
  read = true,
): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(await api.default.markReviewCommentsRead(projectId, agentId, { numbers, unread: !read }))
}

// The comment as markdown, for pasting somewhere else: a quoted body under a link
// back to where it was said. The location is the point - a review remark without
// its file and line is an opinion about nothing.
export function commentAsMarkdown(opts: {
  number: number
  author: string
  body: string
  path?: string
  line?: number
  href?: string
}): string {
  const where = opts.path ? `${opts.path}${opts.line ? `:${opts.line}` : ''}` : ''
  const head = opts.href ? `[#${opts.number}](${opts.href})` : `#${opts.number}`
  const parts = [head, opts.author, where].filter(Boolean)
  return `${parts.join(' - ')}\n\n${opts.body.trim().split('\n').map((l) => `> ${l}`).join('\n')}\n`
}

// The one-shot "Comment to agent" path: store and publish in a single call, so a
// comment sent straight to the agent is just as durable and just as citable as one
// that went through the review queue.
export async function sendReviewComment(
  projectId: string | null,
  agentId: string,
  c: NewComment,
): Promise<void> {
  if (!projectId) return
  await api.default.addReviewComment(projectId, agentId, {
    body: c.text,
    path: c.path,
    line: c.lineNum,
    old_side: !c.isNew,
    diff: `${c.fromLabel} -> ${c.toLabel}`,
    context: c.contextBlock,
    hunk_hash: c.hunkHash,
    publish: true,
  })
}
