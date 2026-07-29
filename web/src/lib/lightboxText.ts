// Turning a text file into the body the lightbox's text viewer renders: one html
// string carrying every line, each with its number.
//
// It is ONE string rather than a node per line because a build log runs to
// thousands of lines, and a React element per line made opening a big one
// visibly slow. Everything per-line - the sticky gutter, the soft wrapping - is
// therefore done in CSS over this string (see .lb-code in index.css) rather than
// in JSX like the repository view's file pane. See LightboxText.

import { highlightLines } from './highlightCore'
import { langFromPath } from './fileKind'

// Above this, syntax highlighting is skipped and the text renders plain. Prism
// runs synchronously on the main thread here (unlike the diff viewer, which has a
// worker), and a megabyte of tokenising is a visible freeze on opening.
export const MAX_HIGHLIGHT_BYTES = 128 * 1024

// buildCodeBody turns a file's text into that html string, plus the gutter width
// the string was numbered for (as a CSS length for --lb-gutter).
export function buildCodeBody(text: string, filename: string): { gutter: string; html: string } {
  const lang = langFromPath(filename)
  // Over the highlight budget (or with no grammar for this extension)
  // highlightLines still returns HTML-escaped lines, which is exactly the plain
  // rendering we want - so the same call covers both.
  const lines = highlightLines(text, text.length > MAX_HIGHLIGHT_BYTES ? 'plaintext' : (lang || 'plaintext'))
  // A file's final newline ends the last line, it doesn't start another one -
  // drop the empty tail it splits into so the gutter counts what an editor
  // would count.
  if (lines.length > 1 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop()
  return {
    // Two digits minimum, so a short file's gutter isn't a sliver, and the
    // column doesn't visibly widen between a 9-line and a 10-line file.
    gutter: `calc(${Math.max(2, String(lines.length).length)}ch + 2rem)`,
    // Joined with nothing: each line is its own block (see .lb-line), so a
    // newline between them would render as a second, empty line.
    //
    // The code sits in its own .lb-tx cell rather than beside the number: the
    // line is a flex row, which is what lets the gutter's dividing rule run the
    // full height of a WRAPPED line instead of stopping after its first row.
    //
    // The <br> in a BLANK line is what keeps a copy honest. Selecting the body
    // serializes the boxes, not the source, and an empty cell next to a
    // user-select:none gutter contributes nothing - so a blank line came out of
    // the clipboard missing entirely (verified in Chromium). A <br> serializes
    // as the newline it stands for and adds no height.
    html: lines
      .map((line, i) => `<span class="lb-line"><span class="lb-ln">${i + 1}</span><span class="lb-tx">${line || '<br>'}</span></span>`)
      .join(''),
  }
}
