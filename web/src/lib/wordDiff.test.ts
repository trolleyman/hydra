import { describe, it, expect } from 'vitest'
import { computeWordDiff, applyWordRanges, buildWordRangeMaps, pairLines, isWhitespaceOnlyChange, renderWordDiffHtml, type WordRange } from './wordDiff'
import { DiffLine } from '../api/models/DiffLine'

// Substring helper: assert each range picks out the expected slice of the line.
function slices(str: string, ranges: WordRange[]): string[] {
  return ranges.map(([s, e]) => str.slice(s, e))
}

describe('computeWordDiff', () => {
  it('returns no ranges for identical lines', () => {
    expect(computeWordDiff('const x = 1', 'const x = 1')).toEqual({ old: [], new: [] })
  })

  it('isolates a single changed token', () => {
    const oldS = 'const x = 1'
    const newS = 'const x = 2'
    const r = computeWordDiff(oldS, newS)
    expect(slices(oldS, r.old)).toEqual(['1'])
    expect(slices(newS, r.new)).toEqual(['2'])
  })

  it('detects a pure insertion in the middle', () => {
    const oldS = 'foo(a)'
    const newS = 'foo(a, b)'
    const r = computeWordDiff(oldS, newS)
    // Nothing removed on the old side, added ", b" on the new side.
    expect(r.old).toEqual([])
    expect(slices(newS, r.new).join('')).toContain('b')
  })

  it('detects a pure deletion in the middle', () => {
    const oldS = 'foo(a, b)'
    const newS = 'foo(a)'
    const r = computeWordDiff(oldS, newS)
    expect(r.new).toEqual([])
    expect(slices(oldS, r.old).join('')).toContain('b')
  })

  it('skips highlighting when both sides are entirely different', () => {
    // No shared token: highlighting the whole of both lines is just noise.
    expect(computeWordDiff('apple', 'orange')).toEqual({ old: [], new: [] })
  })

  it('highlights multiple separate edits', () => {
    const oldS = 'a = foo(x) + 1'
    const newS = 'a = foo(y) + 2'
    const r = computeWordDiff(oldS, newS)
    expect(slices(oldS, r.old)).toEqual(['x', '1'])
    expect(slices(newS, r.new)).toEqual(['y', '2'])
  })

  it('highlights only the added spaces when a line is indented deeper', () => {
    const oldS = '    return ok'
    const newS = '        return ok'
    const r = computeWordDiff(oldS, newS)
    expect(r.old).toEqual([])
    // The four added spaces sit at the end of the indent, right before the code;
    // the four that were already there stay unhighlighted.
    expect(r.new).toEqual([[4, 8]])
  })

  it('highlights only the removed spaces when a line is dedented', () => {
    const oldS = '        return ok'
    const newS = '    return ok'
    const r = computeWordDiff(oldS, newS)
    expect(r.old).toEqual([[4, 8]])
    expect(r.new).toEqual([])
  })

  it('highlights the whole indent when the indent character changes', () => {
    const oldS = '\treturn ok'
    const newS = '    return ok'
    const r = computeWordDiff(oldS, newS)
    expect(slices(oldS, r.old)).toEqual(['\t'])
    expect(slices(newS, r.new)).toEqual(['    '])
  })

  it('highlights only the changed part of a mixed indent', () => {
    const oldS = '\t\tx = 1'
    const newS = '\t    x = 1'
    const r = computeWordDiff(oldS, newS)
    expect(slices(oldS, r.old)).toEqual(['\t'])
    expect(slices(newS, r.new)).toEqual(['    '])
  })

  it('highlights only the added spaces of a realignment', () => {
    const oldS = 'a  = 1'
    const newS = 'a    = 1'
    const r = computeWordDiff(oldS, newS)
    expect(r.old).toEqual([])
    // Two spaces added; only they light up, not the whole padding run.
    expect(r.new).toEqual([[3, 5]])
  })

  it('slides an inserted range to a clean boundary', () => {
    // Inserting an argument: the changed range should read "b, " (aligned to the
    // token boundaries) rather than a ragged ", b" straddling the comma.
    const oldS = 'call(a)'
    const newS = 'call(b, a)'
    const r = computeWordDiff(oldS, newS)
    expect(r.old).toEqual([])
    expect(slices(newS, r.new)).toEqual(['b, '])
  })

  it('does not slide a whitespace-only indent range off the code', () => {
    // Sliding prefers whitespace boundaries, which for a re-indent would drag the
    // highlight away from the code; the guard keeps it on the added columns.
    const oldS = '    x = 1'
    const newS = '        x = 1'
    const r = computeWordDiff(oldS, newS)
    expect(r.old).toEqual([])
    expect(r.new).toEqual([[4, 8]])
  })

  it('handles a change at the end of line', () => {
    const oldS = 'return ok'
    const newS = 'return okay'
    const r = computeWordDiff(oldS, newS)
    // "ok" -> "okay": a character diff highlights only the inserted suffix.
    expect(r.old).toEqual([])
    expect(slices(newS, r.new)).toEqual(['ay'])
  })

  it('diffs inside an identifier at character granularity', () => {
    const oldS = 'const id = getUserName()'
    const newS = 'const id = getUserId()'
    const r = computeWordDiff(oldS, newS)
    // getUserName -> getUserId: only the differing subwords, not the whole token.
    expect(slices(oldS, r.old)).toEqual(['Name'])
    expect(slices(newS, r.new)).toEqual(['Id'])
  })

  it('snaps a mid-camelCase edit out to the subword boundary', () => {
    const oldS = 'onClick={handleClick}'
    const newS = 'onClick={handleClose}'
    const r = computeWordDiff(oldS, newS)
    // The raw char diff is "lick"/"lose"; snapping to the camelCase hump lights
    // the whole changed subword "Click"/"Close" instead.
    expect(slices(oldS, r.old)).toEqual(['Click'])
    expect(slices(newS, r.new)).toEqual(['Close'])
  })

  it('snaps a snake_case edit out to the underscore boundary', () => {
    const oldS = 'handle_click'
    const newS = 'handle_close'
    const r = computeWordDiff(oldS, newS)
    expect(slices(oldS, r.old)).toEqual(['click'])
    expect(slices(newS, r.new)).toEqual(['close'])
  })

  it('keeps a monocase edit precise instead of snapping to the whole word', () => {
    const oldS = 'return counter'
    const newS = 'return pointer'
    const r = computeWordDiff(oldS, newS)
    // No internal subword boundary in counter/pointer, so the char diff stands:
    // the shared "nter" suffix stays unhighlighted (coalesced across the shared
    // "o", not scattered).
    expect(slices(oldS, r.old)).toEqual(['cou'])
    expect(slices(newS, r.new)).toEqual(['poi'])
  })
})

describe('applyWordRanges', () => {
  it('wraps a plain-text range', () => {
    expect(applyWordRanges('const x = 1', [[10, 11]], 'mark'))
      .toBe('const x = <span class="mark">1</span>')
  })

  it('returns html untouched when there are no ranges', () => {
    expect(applyWordRanges('<span>hi</span>', [], 'mark')).toBe('<span>hi</span>')
  })

  it('counts an entity as a single character', () => {
    // "a && b": the "&&" occupies plain positions 2..4. In HTML it is escaped to
    // "&amp;&amp;" - the range must still map to those two entities.
    const html = 'a &amp;&amp; b'
    const out = applyWordRanges(html, [[2, 4]], 'mark')
    expect(out).toBe('a <span class="mark">&amp;&amp;</span> b')
  })

  it('keeps nesting valid when a range crosses an hljs span boundary', () => {
    // hljs span covers "abcd" (0..4); the highlight range covers "cdef" (2..6).
    // The highlight span must not cross the </span> - it is closed and reopened
    // around it so the markup stays well nested.
    const html = '<span class="k">abcd</span>ef'
    const out = applyWordRanges(html, [[2, 6]], 'w')
    expect(out).toBe('<span class="k">ab<span class="w">cd</span></span><span class="w">ef</span>')
  })
})

describe('renderWordDiffHtml', () => {
  it('escapes raw content when there is no highlighted html', () => {
    const out = renderWordDiffHtml(undefined, 'a < b', [[4, 5]], 'w')
    expect(out).toBe('a &lt; <span class="w">b</span>')
  })
})

function line(type: DiffLine.type, content: string, oldN: number | null, newN: number | null): DiffLine {
  return { type, content, old_line_num: oldN, new_line_num: newN }
}

describe('buildWordRangeMaps', () => {
  it('pairs deletions with additions by index and keys by line number', () => {
    const lines: DiffLine[] = [
      line(DiffLine.type.CONTEXT, 'unchanged', 1, 1),
      line(DiffLine.type.DELETION, 'const x = 1', 2, null),
      line(DiffLine.type.ADDITION, 'const x = 2', null, 2),
    ]
    const maps = buildWordRangeMaps(lines)
    expect(maps.old.get(2)).toEqual([[10, 11]])
    expect(maps.new.get(2)).toEqual([[10, 11]])
  })

  it('ignores pure additions with no paired deletion', () => {
    const lines: DiffLine[] = [
      line(DiffLine.type.ADDITION, 'brand new line', null, 5),
    ]
    const maps = buildWordRangeMaps(lines)
    expect(maps.old.size).toBe(0)
    expect(maps.new.size).toBe(0)
  })

  it('aligns the edited line when an addition is inserted ahead of the block', () => {
    // A comment is inserted, then the two originals reappear with one edited.
    // Index pairing would diff "const a = 1" against the comment; similarity
    // pairing lines them up with their real counterparts.
    const lines: DiffLine[] = [
      line(DiffLine.type.DELETION, '  const a = 1', 2, null),
      line(DiffLine.type.DELETION, '  const b = 2', 3, null),
      line(DiffLine.type.ADDITION, '  // a new note', null, 2),
      line(DiffLine.type.ADDITION, '  const a = 1', null, 3),
      line(DiffLine.type.ADDITION, '  const b = 3', null, 4),
    ]
    const maps = buildWordRangeMaps(lines)
    // "const a = 1" is unchanged on both sides -> no highlight at all.
    expect(maps.old.has(2)).toBe(false)
    expect(maps.new.has(3)).toBe(false)
    // The inserted comment has no partner -> no highlight.
    expect(maps.new.has(2)).toBe(false)
    // Only "2" -> "3" is highlighted, on its real pair.
    expect(slices('  const b = 2', maps.old.get(3)!)).toEqual(['2'])
    expect(slices('  const b = 3', maps.new.get(4)!)).toEqual(['3'])
  })
})

describe('pairLines', () => {
  it('pairs one-to-one similar lines in order', () => {
    expect(pairLines(['const x = 1', 'const y = 2'], ['const x = 9', 'const y = 8']))
      .toEqual([[0, 0], [1, 1]])
  })

  it('leaves an unbalanced block partly unpaired', () => {
    // Two removed, one added: only the best match pairs; the other is dropped.
    const pairs = pairLines(['foo(a, b)', 'wildly different line'], ['foo(a, b, c)'])
    expect(pairs).toEqual([[0, 0]])
  })

  it('refuses to pair unrelated lines', () => {
    expect(pairLines(['the quick brown fox'], ['SELECT * FROM users'])).toEqual([])
  })

  it('skips a mid-block insertion to keep later lines aligned', () => {
    const pairs = pairLines(
      ['alpha = 1', 'beta = 2'],
      ['inserted = 0', 'alpha = 1', 'beta = 20'],
    )
    expect(pairs).toEqual([[0, 1], [1, 2]])
  })
})

describe('isWhitespaceOnlyChange', () => {
  it('is true for a re-indent and an internal realignment', () => {
    expect(isWhitespaceOnlyChange('  doThing()', '      doThing()')).toBe(true)
    expect(isWhitespaceOnlyChange('Host   = 1', 'Host = 1')).toBe(true)
  })

  it('is false for a real code change and for identical lines', () => {
    expect(isWhitespaceOnlyChange('const x = 1', 'const x = 2')).toBe(false)
    expect(isWhitespaceOnlyChange('same', 'same')).toBe(false)
  })
})
