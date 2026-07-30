// The "Submit review" control in the diff viewer's Changes bar. It only mounts
// when there's at least one queued "Add to review" comment; it shows the count,
// and clicking it opens a popover listing every queued comment (with a per-item
// remove and a "diff changed" flag for comments whose anchoring hunk has since
// moved) plus the button that submits the whole batch to the agent at once.
//
// The comments are server-side objects (see lib/reviewComments.ts); this component
// is purely presentational - the parent (DiffViewer) owns the state and the
// submit/remove actions.
//
// Each comment has a checkbox, all ticked by default. Submitting the whole batch
// is what you almost always want, so it stays one click - but a review often has
// one comment you are not sure enough about to send yet, and without this the only
// way to hold it back was to delete it and rewrite it later.

import { useEffect, useRef, useState } from 'react'
import { MessagesSquare, Trash2, Send, TriangleAlert, X } from 'lucide-react'
import type { PendingReviewComment } from '../lib/reviewComments'
import { Tooltip } from './Tooltip'

export function ReviewDraftPopover({ comments, staleIds, submitting, onSubmit, onRemove, onJump }: {
  comments: PendingReviewComment[]
  staleIds: Set<string>
  submitting: boolean
  // Publish these numbers. Empty (never happens - the button disables) would mean
  // "all", which is the API's own default.
  onSubmit: (numbers: number[]) => void
  onRemove: (id: string) => void
  // Scroll the diff to a queued comment's line. Provided by the diff viewer;
  // clicking a comment invokes it and closes the popover.
  onJump: (comment: PendingReviewComment) => void
}) {
  const [open, setOpen] = useState(false)
  // Held OUT of the selection rather than in it, so a comment queued while the
  // popover is open is included by default - the common case is "send everything",
  // and a newly written comment appearing pre-unticked would be a trap.
  const [heldBack, setHeldBack] = useState<Set<number>>(new Set())
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape while the popover is open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Nothing queued -> render nothing (the button appears only once there's a
  // review to submit).
  if (comments.length === 0) return null

  const staleCount = comments.reduce((n, c) => n + (staleIds.has(c.id) ? 1 : 0), 0)
  const selected = comments.filter((c) => !heldBack.has(c.number))
  const toggle = (n: number) =>
    setHeldBack((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  return (
    <div ref={wrapRef} className="relative">
      <Tooltip content="Review queued comments and submit them all at once" side="bottom">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors cursor-pointer shadow-sm"
        >
          <MessagesSquare className="w-3.5 h-3.5" />
          <span>Submit review</span>
          <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-white/25 text-3xs tabular-nums leading-none">
            {comments.length}
          </span>
          {staleCount > 0 && (
            <TriangleAlert className="w-3.5 h-3.5 text-amber-200" />
          )}
        </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-[60] w-[22rem] max-w-[90vw] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              Review comments <span className="text-gray-400 dark:text-gray-500 tabular-nums">{comments.length}</span>
            </h3>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {staleCount > 0 && (
            <div className="flex items-start gap-1.5 px-3 py-2 text-2xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/50">
              <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                {staleCount === 1 ? 'One comment was' : `${staleCount} comments were`} written against a diff that
                has since changed. {staleCount === 1 ? 'It' : 'They'} will still be sent with the original context.
              </span>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto py-1">
            {comments.map((c) => {
              const stale = staleIds.has(c.id)
              return (
                <div key={c.id} className="group flex items-start gap-2 px-1 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                  <Tooltip content={heldBack.has(c.number) ? 'Include in this review' : 'Hold this one back'} side="top">
                    <input
                      type="checkbox"
                      checked={!heldBack.has(c.number)}
                      onChange={() => toggle(c.number)}
                      aria-label={`Include comment on ${c.path}:${c.lineNum}`}
                      className="mt-3 ml-1.5 shrink-0 accent-blue-600 cursor-pointer"
                    />
                  </Tooltip>
                  {/* No hover tip on the row itself: it wraps the stale-diff
                      warning below, so hovering that icon would stack two
                      bubbles. The row is self-evidently clickable (hover
                      highlight, pointer cursor, path:line), so the hint lives on
                      aria-label where it still reaches assistive tech. */}
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => { onJump(c); setOpen(false) }}
                      aria-label="Jump to this line in the diff"
                      className="min-w-0 w-full text-left px-2 py-2 rounded cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5 text-2xs font-mono text-gray-500 dark:text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        <span className="truncate" title={c.path}>{c.path}</span>
                        <span className="shrink-0 text-gray-400 dark:text-gray-500">:{c.lineNum}</span>
                        {stale && (
                          <Tooltip content="The diff around this line changed after the comment was queued" side="top">
                            <span className="shrink-0 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                              <TriangleAlert className="w-3 h-3" />
                            </span>
                          </Tooltip>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words line-clamp-3">
                        {c.text}
                      </div>
                    </button>
                  </div>
                  <Tooltip content="Remove" side="top">
                    <button
                      onClick={() => onRemove(c.id)}
                      aria-label="Remove comment"
                      className="shrink-0 mt-2 mr-1 p-1 rounded text-gray-400 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-200 dark:border-gray-700">
            {heldBack.size > 0 && (
              <span className="mr-auto text-2xs text-gray-400 dark:text-gray-500">
                {heldBack.size} held back
              </span>
            )}
            <button
              disabled={submitting || selected.length === 0}
              onClick={() => onSubmit(selected.map((c) => c.number))}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              {submitting ? 'Sending...' : `Submit ${selected.length} comment${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
