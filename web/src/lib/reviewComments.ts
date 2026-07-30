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
import type { ReviewComment } from '../api'

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
  createdAt: number
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
    createdAt: Date.parse(c.created_at) || 0,
  }
}

// Every comment, drafts and published alike. The diff viewer renders both in the
// gutter - a comment an agent left is worth nothing if you cannot see it - but
// only the drafts drive the queued-comment popover and the submit count, since a
// published comment has left and the server refuses to edit or delete it.
function all(res: { comments: ReviewComment[] }): PendingReviewComment[] {
  return res.comments.map(toPending)
}

/** The unpublished subset: what "Submit review" would send. */
export function draftsOf(comments: PendingReviewComment[]): PendingReviewComment[] {
  return comments.filter((c) => !c.published)
}

export async function fetchReviewComments(projectId: string | null, agentId: string): Promise<PendingReviewComment[]> {
  if (!projectId) return []
  return all(await api.default.getReviewComments(projectId, agentId))
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
): Promise<{ comments: PendingReviewComment[]; notified: string | null }> {
  if (!projectId) return { comments: [], notified: null }
  const res = await api.default.publishReviewComments(projectId, agentId, {})
  return { comments: all(res), notified: res.notified ?? null }
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
