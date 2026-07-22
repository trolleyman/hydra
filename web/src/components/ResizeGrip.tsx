import { memo } from 'react'

// The unified indicator for every drag-to-resize handle: invisible at rest, a
// rounded pill on hover, solid while dragging. Only the visual is shared - the
// hit area (an invisible strip with the resize cursor + drag handlers) stays at
// each call site, which must carry the `group/resize` class so the hover/active
// states light this pill. Namespaced (`/resize`) so an ancestor `group` (a
// hoverable card, the sidebar) can't light it from afar.
// memo: a pure presentational leaf whose only prop is a constant orientation, so
// it never needs to re-render with its parent. It sits inside frequently
// re-rendering shells (the chat composer, sidebar, diff and spawn cards all
// re-render on live ticks / keystrokes), where skipping it is free.
export const ResizeGrip = memo(function ResizeGrip({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const size = orientation === 'vertical' ? 'w-1 h-10' : 'h-1 w-10'
  return (
    <div
      className={`${size} rounded-full bg-transparent group-hover/resize:bg-blue-400/70 group-active/resize:bg-blue-500 transition-colors`}
    />
  )
})
