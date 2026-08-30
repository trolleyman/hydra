// Browser scrollbar chrome is part of the scroll element rather than a DOM
// child. Treat a pointer press in its right-hand gutter as explicit scroll
// ownership so live bottom-following cannot fight a thumb drag.
export function isVerticalScrollbarPointer(element: HTMLElement, clientX: number): boolean {
  const rect = element.getBoundingClientRect()
  const gutter = Math.max(element.offsetWidth - element.clientWidth, 12)
  return clientX >= rect.right - gutter && clientX <= rect.right
}

export function historyThresholdTransition(
  scrollTop: number,
  armed: boolean,
  threshold = 300,
): { armed: boolean; request: boolean } {
  if (scrollTop >= threshold) return { armed: true, request: false }
  if (!armed) return { armed: false, request: false }
  return { armed: false, request: true }
}
