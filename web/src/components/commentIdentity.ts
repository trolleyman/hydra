import { createContext } from 'react'

// Who owns the comments in this subtree. Provided once near a diff / chat pane so
// a comment handle rendered deep inside a memo'd row can become its permalink
// (components/CommentLink) without threading the ids down and busting those memos
// (the same reasoning as reviewThreadContext). Null off any head (a plain
// repository diff) - the handle then renders as text.
//
// Its own module, not CommentLink.tsx: a file that exports a component must export
// nothing else, or fast refresh stops working for it (react-refresh/only-export-components).
export const CommentIdentityContext = createContext<{ projectId: string; agentId: string } | null>(null)
