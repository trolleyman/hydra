// In-progress review drafts: the text you are part-way through typing, before it
// becomes a comment. Persisted to localStorage per project + agent so closing a
// box, reloading, or switching away and back restores the half-written words.
//
// The QUEUED comments used to live here too. They do not any more - they are
// server-side objects with numbers now (see lib/reviewComments.ts), because a
// review that dies on a reload, and cannot be pointed at afterwards, is barely a
// review. What is left here is deliberate: this text is keystroke-frequency and
// pre-commitment, so a round trip per keystroke would be absurd and nothing else
// ever needs to see it.

import { lineDraftKey, LINE_DRAFT_PREFIX, threadDraftKey, THREAD_DRAFT_PREFIX, createShardedStore } from './storage'

type LineDrafts = { drafts: Record<string, string> }

const REVIEW_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// ── In-progress line-comment drafts ──────────────────────────────────────────
// The text a user is part-way through typing in a line's comment box, BEFORE
// they hit "Add to review" (which promotes it to a server-side comment - see
// lib/reviewComments.ts) or "Send". Persisted per line so closing the box, reloading the page, or
// switching away and reopening the same line restores the half-written comment.
// One store entry per project + agent holds a map of line-key -> text.

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

// ── In-progress forge-thread replies ─────────────────────────────────────────
// The same idea as the line drafts above, for the reply box on a FORGE review
// thread (docs/review-threads.md): a thread card can scroll out of view (which
// unmounts it) or the page can reload mid-sentence, and losing a half-written
// reply to a reviewer is worse than losing a note to the agent. Keyed by thread
// id, which is stable for the life of the thread on both forges.

const threadStore = createShardedStore<LineDrafts>(THREAD_DRAFT_PREFIX, REVIEW_DRAFT_TTL_MS)

// The saved in-progress reply for a thread, or '' when nothing is stored.
export function loadThreadDraft(projectId: string | null, agentId: string, threadId: string): string {
  return threadStore.load(threadDraftKey(projectId, agentId))?.drafts?.[threadId] ?? ''
}

// Persist (or, for empty text, drop) the in-progress reply for a thread.
export function saveThreadDraft(projectId: string | null, agentId: string, threadId: string, text: string): void {
  const key = threadDraftKey(projectId, agentId)
  const drafts = { ...(threadStore.load(key)?.drafts ?? {}) }
  if (text.trim()) drafts[threadId] = text
  else delete drafts[threadId]
  threadStore.save(key, { drafts })
}

// Drop the in-progress reply for a thread (after it's been posted or saved).
export function clearThreadDraft(projectId: string | null, agentId: string, threadId: string): void {
  saveThreadDraft(projectId, agentId, threadId, '')
}

// Drop expired line-draft and thread-draft entries. Cheap to call once on app
// boot.
export function pruneReviewDrafts(): void {
  lineStore.prune()
  threadStore.prune()
}
