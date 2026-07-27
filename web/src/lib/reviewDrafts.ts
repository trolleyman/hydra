// Pending review comments queued per agent, persisted to localStorage so a batch
// of "Add to review" comments survives reloads and agent switches until the user
// hits "Submit review" (which sends them all to the agent and clears the draft).
//
// This mirrors agentViewPrefs.ts (a sharded, per-project+agent, TTL'd store) but
// is deliberately separate: agentViewPrefs holds transient view state, whereas a
// review draft is user-authored content with its own clear-on-submit lifecycle.
// Keeping them apart means submitting a review can wipe the draft cleanly without
// touching layout prefs, and the two prune independently.

import { reviewDraftKey, REVIEW_DRAFT_PREFIX, lineDraftKey, LINE_DRAFT_PREFIX, createShardedStore } from './storage'
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

// Replace the text of one queued comment (in-place edit), returning the new list.
// A no-op if the id isn't found. The comment keeps its original anchor, frozen
// context block and hunk hash - only the authored text changes.
export function updateReviewComment(
  projectId: string | null,
  agentId: string,
  id: string,
  text: string,
): PendingReviewComment[] {
  const next = loadReviewDraft(projectId, agentId).map((c) => (c.id === id ? { ...c, text } : c))
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

// ── In-progress line-comment drafts ──────────────────────────────────────────
// The text a user is part-way through typing in a line's comment box, BEFORE
// they hit "Add to review" (which promotes it to a PendingReviewComment above)
// or "Send". Persisted per line so closing the box, reloading the page, or
// switching away and reopening the same line restores the half-written comment.
// One store entry per project + agent holds a map of line-key -> text.

type LineDrafts = { drafts: Record<string, string> }

const lineStore = createShardedStore<LineDrafts>(LINE_DRAFT_PREFIX, REVIEW_DRAFT_TTL_MS)

// A line-key uniquely identifies a diff line within a file: path + side + number.
// The separator is a NUL, which can't appear in a path or line number, so keys
// never collide - written as the '\u0000' escape, never a raw NUL byte (a raw
// NUL would make grep treat this file as binary; see the "no raw control bytes"
// rule in CLAUDE.md, and the same idiom in lib/testCases.ts).
function lineKey(path: string, lineNum: number, isNew: boolean): string {
  return `${path}\u0000${isNew ? 'new' : 'old'}\u0000${lineNum}`
}

// The saved in-progress text for a line, or '' when nothing is stored.
export function loadLineDraft(
  projectId: string | null,
  agentId: string,
  path: string,
  lineNum: number,
  isNew: boolean,
): string {
  const stored = lineStore.load(lineDraftKey(projectId, agentId))
  return stored?.drafts?.[lineKey(path, lineNum, isNew)] ?? ''
}

// Persist (or, for empty text, drop) the in-progress draft for a line.
export function saveLineDraft(
  projectId: string | null,
  agentId: string,
  path: string,
  lineNum: number,
  isNew: boolean,
  text: string,
): void {
  const key = lineDraftKey(projectId, agentId)
  const drafts = { ...(lineStore.load(key)?.drafts ?? {}) }
  const k = lineKey(path, lineNum, isNew)
  if (text.trim()) drafts[k] = text
  else delete drafts[k]
  lineStore.save(key, { drafts })
}

// Drop the in-progress draft for a line (after it's been queued or sent).
export function clearLineDraft(
  projectId: string | null,
  agentId: string,
  path: string,
  lineNum: number,
  isNew: boolean,
): void {
  saveLineDraft(projectId, agentId, path, lineNum, isNew, '')
}

// Drop expired review-draft and line-draft entries. Cheap to call once on app boot.
export function pruneReviewDrafts(): void {
  store.prune()
  lineStore.prune()
}
