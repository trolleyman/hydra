import { checkerStyle } from './artifactDiffShared'

// The checkerboard as its own layer BEHIND the media, rather than a background on the
// <img> itself - which is what it used to be, and which showed as a faint bright edge
// around every picture. An image is laid out at fractional CSS pixels and rasterised
// at whole device ones, so its paint doesn't quite reach the edges of its own box
// (and `object-contain` letterboxes it by a further fraction when the reserved
// aspect ratio and the decoded one disagree in the last decimal) - leaving a sliver
// of backdrop lit up along one or two edges. Inset by a pixel, the checkerboard
// simply cannot reach that sliver.
//
// Its parent must be positioned and hug the media (the tiles' `relative` media box,
// the lightbox's wrapper around its <img>). The picture on top needs to be positioned
// too - `relative`/`absolute` - to paint above this layer.
export function CheckerLayer({ className, style }: {
  className?: string
  /** Overrides the checkerboard itself; defaults to the subtle in-page one. The
   *  lightbox passes a bolder pattern that reads on its dark backdrop. */
  style?: React.CSSProperties
}) {
  return <div aria-hidden className={`absolute inset-px pointer-events-none ${className ?? ''}`} style={style ?? checkerStyle} />
}
