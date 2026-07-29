import { useEffect, useState, type ReactNode } from 'react'

// CollapseSlide is THE expand/collapse glide in this UI: a `grid-template-rows`
// tween between 0fr and 1fr over an `overflow-hidden` wrapper, because
// `height: auto` can't be transitioned and measuring heights - per row, in a
// tree, on every toggle - is both fiddly and slow.
//
// It exists because five components had grown their own copy of that trick, each
// subtly different (ease-out vs ease-in-out, `min-h-0` present or missing,
// `inert` on one of them), and each with its own answer to the real question:
// what happens to the body while it's shut.
//
// Two answers, and the choice is about COST, not looks:
//
//   - `keepMounted` (the default): the body is always rendered and just clipped.
//     Right when the content is cheap or has state worth keeping alive while
//     hidden - a settings section, a prompt card, the diff's file tree. The
//     closed copy gets `inert`, so it's out of tab order and off the a11y tree
//     rather than being invisible-but-focusable.
//   - `keepMounted={false}`: the body mounts the instant `open` flips true and is
//     dropped a beat after it closes. Right for anything heavy - the repository
//     file tree, a test tree holding a thousand green cases - and it compounds in
//     a RECURSIVE tree: an unmounted row never renders, so its own children are
//     never created either, and a shut subtree costs O(0) instead of O(subtree).
//
// Two details the hand-rolled copies kept getting wrong, both handled here:
// the body renders during the SAME render that flips `open` (not an effect-frame
// later), so the tween has real content to grow into instead of gliding open
// over nothing; and a region that is open on FIRST paint renders at 1fr straight
// away, so it appears open with no glide - only a toggle animates.
//
// Two collapses in this app deliberately do NOT use it, and should stay that
// way - the grid trick was tried in both and lost:
//   - CollapsibleCard tweens a MEASURED height, because its body can resize
//     itself while open (a streaming log) and the card has to follow.
//   - AgentChat's `Expandable` tweens a measured max-height, because with a
//     nested scroll container inside, the grid container's height ran ahead of
//     the resolved fr track mid-transition and left a transient empty gap.
// Reach for a measured height when the content has its own scroller or grows on
// its own; the fr tween is for the ordinary case, where it is free.
export const COLLAPSE_MS = 200

export function CollapseSlide({ open, keepMounted = false, children }: {
  open: boolean
  keepMounted?: boolean
  children: ReactNode
}) {
  // Only tracked for the unmounting variant; the keepMounted path ignores it.
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (keepMounted) return
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [open, keepMounted])
  return (
    <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
      <div className="overflow-hidden min-h-0" inert={keepMounted ? !open : undefined}>
        {keepMounted || open || mounted ? children : null}
      </div>
    </div>
  )
}
