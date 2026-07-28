import { createContext, useContext } from 'react'
import type { ReviewThreadActions } from '../components/ReviewThreadCard'

// The diff viewer's forge-thread actions, passed by context rather than props:
// the thread cards render deep inside two memo'd hunk components, and threading
// four more callbacks through them would bust their memos on every parent
// render (the same reason artifactDiffContext exists).
//
// Null means "this head has no MR", which is also how the thread cards stay
// absent from the repository diff view.
export const ReviewThreadContext = createContext<ReviewThreadActions | null>(null)

export function useReviewThreadActions(): ReviewThreadActions | null {
  return useContext(ReviewThreadContext)
}
