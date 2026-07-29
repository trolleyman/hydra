// The lightbox text viewer's body builder: the numbering, the blank-line and
// the trailing-newline rules. These are the parts that go quietly wrong - a
// gutter that counts one line more than an editor does, or a blank line that
// disappears out of a copied selection.
import { describe, expect, it } from 'vitest'
import { buildCodeBody } from './lightboxText'

// The line elements the builder emits, as [number, code html] pairs.
function lines(html: string): [string, string][] {
  return [...html.matchAll(/<span class="lb-ln">(\d+)<\/span><span class="lb-tx">(.*?)<\/span><\/span>/g)]
    .map((m) => [m[1], m[2]])
}

// Splitting on the line wrapper is enough for counting and doesn't care how a
// line's own markup nests.
function lineHtml(html: string): string[] {
  return html.split('<span class="lb-line">').slice(1)
}

describe('buildCodeBody', () => {
  it('numbers every line from 1', () => {
    const { html } = buildCodeBody('alpha\nbeta\ngamma', 'notes.txt')
    expect(lines(html)).toEqual([['1', 'alpha'], ['2', 'beta'], ['3', 'gamma']])
  })

  it("does not count a file's final newline as another line", () => {
    expect(lineHtml(buildCodeBody('alpha\nbeta\n', 'notes.txt').html)).toHaveLength(2)
    // A blank line the file really ends with (two newlines) still counts.
    expect(lineHtml(buildCodeBody('alpha\nbeta\n\n', 'notes.txt').html)).toHaveLength(3)
  })

  it('gives a blank line a <br> so it survives a copied selection', () => {
    // An empty block with only the user-select:none gutter in it serializes to
    // nothing, which dropped the blank line out of the clipboard entirely.
    expect(lines(buildCodeBody('alpha\n\nbeta', 'notes.txt').html))
      .toEqual([['1', 'alpha'], ['2', '<br>'], ['3', 'beta']])
  })

  it('joins the lines with nothing - each is its own block', () => {
    // A newline between the blocks would render as a second, empty line.
    expect(buildCodeBody('alpha\nbeta', 'notes.txt').html).not.toContain('\n')
  })

  it('widens the gutter with the line count, from two digits', () => {
    expect(buildCodeBody('one line', 'a.txt').gutter).toBe('calc(2ch + 2rem)')
    expect(buildCodeBody('x\n'.repeat(99), 'a.txt').gutter).toBe('calc(2ch + 2rem)')
    expect(buildCodeBody('x\n'.repeat(100), 'a.txt').gutter).toBe('calc(3ch + 2rem)')
    expect(buildCodeBody('x\n'.repeat(1000), 'a.txt').gutter).toBe('calc(4ch + 2rem)')
  })

  it('escapes the file so its text can never be markup', () => {
    const { html } = buildCodeBody('<script>alert(1)</script>', 'notes.txt')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('highlights by the filename extension', () => {
    const { html } = buildCodeBody('const answer = 42', 'app.ts')
    expect(html).toContain('token keyword')
    // The same text under a name with no grammar stays plain (but numbered).
    expect(buildCodeBody('const answer = 42', 'notes.txt').html).not.toContain('token')
  })

  it('gives the number and the code a cell each', () => {
    // The line is a flex row: the gutter cell is what goes sticky and
    // select-none, and what stretches its dividing rule down a wrapped line.
    expect(buildCodeBody('alpha', 'notes.txt').html)
      .toBe('<span class="lb-line"><span class="lb-ln">1</span><span class="lb-tx">alpha</span></span>')
  })
})
