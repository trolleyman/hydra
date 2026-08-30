import { useContext, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { commentPermalink, jumpToReviewComment } from '../lib/reviewCommentLink'
import { CommentIdentityContext } from './commentIdentity'

// CommentLink renders a comment's handle (#N) as its permalink, so reading about
// a comment and going to look at it are one click apart. A real <a href> - so
// copy-link-address, middle-click and paste-into-a-message all behave - whose
// plain click is handled in-app: the number IS the address, and navigating to
// following `#comment-N` would push a history entry to scroll a diff already on the
// page, then do nothing at all the second time you clicked the same link. Without
// a mounted diff for this head (a sub-agent view, a page with no diff) the href is
// followed and the page honours the number on load. See lib/reviewCommentLink.
export function CommentLink({ number, className, children }: { number: number; className: string; children: ReactNode }) {
  const id = useContext(CommentIdentityContext)
  if (!id) return <span className={className}>{children}</span>
  return (
    <Tooltip content={`Go to #${number} in the diff`} side="top">
      <a
        href={commentPermalink(id.projectId, id.agentId, number)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          if (jumpToReviewComment(id.agentId, number)) e.preventDefault()
        }}
        className={className}
      >
        {children}
      </a>
    </Tooltip>
  )
}
