import { createContext, useContext } from 'react'

// The enclosing ZoomPan frame's current magnification, published to whatever is
// rendered inside it.
//
// Anything overlaid ON the content - a review pin marking a spot on a screenshot -
// wants to travel and zoom WITH the picture (so it keeps pointing at the same
// pixels) while staying its own size on screen (so a pin at 8x isn't a dinner
// plate). Living inside the transformed content gets the first for free; the
// second needs the scale, to divide back out.
//
// Its own module rather than a second export from ZoomPan.tsx: a file that
// exports both a component and a hook loses fast refresh
// (react-refresh/only-export-components), and this is shared by definition.
//
// 1 outside any frame, which is the right answer for an overlay on a picture that
// cannot be zoomed at all.
export const ZoomScaleContext = createContext(1)

/** The magnification of the enclosing ZoomPan, for content that must counter-scale
 *  to keep a constant on-screen size. */
export function useZoomScale(): number {
  return useContext(ZoomScaleContext)
}
