// Pending review comments queued per agent, persisted to localStorage so a batch
// of "Add to review" comments survives reloads and agent switches until the user
// hits "Submit review" (which sends them all to the agent and clears the draft).
//
// This mirrors agentViewPrefs.ts (a sharded, per-project+agent, TTL'd store) but
// is deliberately separate: agentViewPrefs holds transient view state, whereas a
// review draft is user-authored content with its own clear-on-submit lifecycle.
// Keeping them apart means submitting a review can wipe the draft cleanly without
// touching layout prefs, and the two prune independently.

import { reviewDraftKey, REVIEW_DRAFT_PREFIX, createShardedStore } from './storage'
import { randomId } from './uuid'

// One queued comment. `path` + `lineNum` + `isNew` anchor it to a diff line the
// same way DiffViewer's live-comment path does (isNew picks new-side vs old-side
// numbering). We also freeze everything needed to submit the comment later,
// independent of the live diff:
//   - fromLabel/toLabel: the diff comparison it was written against (resolved to
//     concrete refs at add time, so "latest commit" doesn't drift by submit).
//   - contextBlock: the ```diff ...``` snippet of surrounding lines, captured now
//     so the comment still carries its context even if the file/hunk later
//     changes or disappears.
//   - hunkHash: a hash of the anchoring hunk at add time. On render we recompute
//     the current hunk's hash; a mismatch (or a missing line) means the diff has
//     moved under the comment, so the UI can flag it as stale.
export interface PendingReviewComment {
  id: string
  path: string
  lineNum: number
  isNew: boolean
  text: string
  fromLabel: string
  toLabel: string
  contextBlock: string
  hunkHash: string
  createdAt: number
}

type ReviewDraft = { comments: PendingReviewComment[] }

const REVIEW_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

const store = createShardedStore<ReviewDraft>(REVIEW_DRAFT_PREFIX, REVIEW_DRAFT_TTL_MS)

// A collision-resistant id for a queued comment. randomId handles the insecure
// (plain-http LAN) context where crypto.randomUUID is absent.
function newId(): string {
  return randomId()
}

// Load the queued comments for an agent. Returns [] when nothing is stored or the
// entry has expired.
export function loadReviewDraft(projectId: string | null, agentId: string): PendingReviewComment[] {
  const stored = store.load(reviewDraftKey(projectId, agentId))
  return stored?.comments ?? []
}

// Append a comment to the agent's draft and return the new list (so the caller can
// drive React state off the same value it persisted).
export function addReviewComment(
  projectId: string | null,
  agentId: string,
  comment: Omit<PendingReviewComment, 'id' | 'createdAt'>,
): PendingReviewComment[] {
  const next = [
    ...loadReviewDraft(projectId, agentId),
    { ...comment, id: newId(), createdAt: Date.now() },
  ]
  store.save(reviewDraftKey(projectId, agentId), { comments: next })
  return next
}

// Remove one queued comment by id, returning the new list.
export function removeReviewComment(
  projectId: string | null,
  agentId: string,
  id: string,
): PendingReviewComment[] {
  const next = loadReviewDraft(projectId, agentId).filter((c) => c.id !== id)
  store.save(reviewDraftKey(projectId, agentId), { comments: next })
  return next
}

// Drop the whole draft (used after a successful submit).
export function clearReviewDraft(projectId: string | null, agentId: string): void {
  store.save(reviewDraftKey(projectId, agentId), { comments: [] })
}

// Drop expired review-draft entries. Cheap to call once on app boot.
export function pruneReviewDrafts(): void {
  store.prune()
}
