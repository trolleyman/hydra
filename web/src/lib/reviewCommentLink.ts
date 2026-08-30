// A review comment's address, and the way to follow it from outside the diff.
//
// A comment has ONE address - its number - and two ways of being reached:
//
//   - commentPermalink is the `#comment-N` URL fragment. It is what "Copy link"
//     copies and what an anchor's href is, so standard link actions all behave.
//   - jumpToReviewComment is the in-place jump, for a click on a page that is
//     ALREADY showing that head. Navigating there would push a history entry and
//     re-run the page for a scroll; and clicking the same link twice would do
//     nothing at all, because the URL would not change.
//
// The jump is a registry rather than a prop or a context because the two ends are
// siblings: the diff viewer owns the jump (it needs the mounted, laid-out diff to
// scroll within), and the chat pane - several levels down a different subtree -
// is what wants to call it. Keyed by head id, so a pane can only ever drive the
// diff of the head it belongs to.

import { createContext, useContext } from 'react'

export function commentPermalink(projectId: string | null, agentId: string, number: number): string {
  return `${window.location.origin}/project/${encodeURIComponent(projectId ?? '_')}/agent/${encodeURIComponent(agentId)}#comment-${number}`
}

// The one comment currently carrying the short-lived navigation cue. By context,
// not a prop, for the same reason ReviewThreadContext is: the cards
// render inside two memo'd hunk components, and a set threaded through them
// would re-render every line of every file each time it grew.
export const VisitedCommentsContext = createContext<number | null>(null)

// useIsCurrentComment reports whether this comment is one you have been taken to.
// Numbers are never reused, so identity is the whole test.
export function useIsCurrentComment(number: number | readonly number[]): boolean {
  const current = useContext(VisitedCommentsContext)
  return Array.isArray(number) ? number.includes(current ?? -1) : current === number
}

type Jump = (number: number) => void

const jumps = new Map<string, Jump>()

// registerCommentJump publishes a head's "scroll to comment N", and returns the
// unregister to call on unmount. The identity check on removal means a remount
// that registers before the old effect cleans up cannot leave the map empty.
export function registerCommentJump(agentId: string, jump: Jump): () => void {
  jumps.set(agentId, jump)
  return () => { if (jumps.get(agentId) === jump) jumps.delete(agentId) }
}

// jumpToReviewComment scrolls this head's diff to a comment, reporting whether
// anything was there to do it. False means no diff is mounted for that head, and
// the caller should follow the permalink instead.
export function jumpToReviewComment(agentId: string, number: number): boolean {
  const jump = jumps.get(agentId)
  if (!jump) return false
  jump(number)
  return true
}
