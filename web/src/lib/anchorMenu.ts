// Horizontal placement for a portalled dropdown/popover anchored to a trigger.
//
// Every portalled menu in the app used to hand-roll this, and they disagreed:
// some pinned the panel's LEFT edge to the trigger and opened rightward
// (BranchSelector, ProjectDropdown, SettingsSelect), others pinned its RIGHT
// edge and opened leftward (SettingsPopover, PRPicker). The second kind reads
// wrong on a trigger that isn't at the right edge of its container - the
// agent header's "check out locally" popover spilled back over the sidebar
// while the base-branch selector two chips along opened rightward, so two
// neighbouring controls behaved oppositely.
//
// The default is now 'auto': open rightward (left edge on the trigger's left
// edge) whenever the panel fits there, and only fall back to opening leftward
// when it doesn't. A cog at the right end of a wide toolbar has no room to its
// right, so it still opens leftward exactly as before - the flip is what makes
// one rule cover both cases.
export type MenuAlign = 'auto' | 'left' | 'right'

export type MenuPlacement = {
  // Viewport-relative `left` for a position: fixed panel.
  left: number
  // The width to render at - `width`, unless `minWidth` allowed shrinking to
  // fit the room on the chosen side.
  width: number
  // Which of the panel's edges ended up on the trigger. Callers don't need it,
  // but it makes the behaviour assertable in tests.
  side: 'left' | 'right'
}

export function placeMenu({
  triggerLeft,
  triggerRight,
  width,
  viewportWidth,
  align = 'auto',
  pad = 8,
  minWidth,
}: {
  triggerLeft: number
  triggerRight: number
  // Desired panel width in px.
  width: number
  viewportWidth: number
  align?: MenuAlign
  // Margin kept between the panel and each viewport edge.
  pad?: number
  // When set, the panel may shrink below `width` (down to this floor) to fit
  // the room on its opening side, instead of being pushed sideways. Leave it
  // unset for a panel whose layout needs its full width.
  minWidth?: number
}): MenuPlacement {
  // Room for a panel opening rightward from the trigger's left edge, and for
  // one opening leftward from its right edge.
  const roomRight = viewportWidth - triggerLeft - pad
  const roomLeft = triggerRight - pad

  // Prefer rightward. Take leftward only when the panel doesn't fit rightward
  // AND there is genuinely more room the other way - so a trigger near the
  // right edge flips, but one merely a little short of the full width in a
  // narrow window doesn't jump sides for a pixel.
  const side: 'left' | 'right' =
    align === 'auto' ? (roomRight >= width || roomRight >= roomLeft ? 'left' : 'right') : align

  const floor = minWidth ?? width
  const room = side === 'left' ? roomRight : roomLeft
  // Never wider than the viewport allows, whatever the caller asked for.
  const w = Math.min(Math.min(width, Math.max(floor, room)), Math.max(0, viewportWidth - pad * 2))

  const left = side === 'left' ? triggerLeft : triggerRight - w
  return { left: Math.min(Math.max(pad, left), Math.max(pad, viewportWidth - w - pad)), width: w, side }
}
