// Compose one diff line's syntax highlighting, changed-word overlay and
// whitespace marks. Both the repository diff and the chat Edit preview use this
// path so the same source line cannot pick up a different treatment depending
// on which surface renders it.
import { renderWordDiffHtml, type WordRange } from './wordDiff'
import { markWhitespace, markWhitespaceText, type WhitespaceMarks } from './whitespaceMarks'

export function diffCodeHtml(
  highlighted: string | undefined,
  content: string,
  ranges: WordRange[] | undefined,
  wordClass: string,
  ws: WhitespaceMarks,
): string | null {
  const html = ranges?.length
    ? renderWordDiffHtml(highlighted, content, ranges, wordClass)
    : highlighted
  if (html != null) return markWhitespace(html, ws)
  return markWhitespaceText(content, ws)
}
