// Diff row geometry: the class strings every diff row is built from, plus an
// offscreen probe that measures how tall a file's body WILL be before its rows
// exist.
//
// Why this exists: file bodies mount lazily (DiffViewer's `near` latch), so an
// off-screen card holds a placeholder sized from an estimate. The estimate used
// to assume one 20px row per diff line - but rows wrap (`whitespace-pre-wrap
// break-words`), so on real code it ran 5-20% short per file, and the shortfall
// was only paid back as each card mounted. That is what made the scrollbar thumb
// shrink while you scrolled, and what forced the re-correcting rAF loops in
// diffScroll.ts.
//
// So the wrap is resolved up front instead. Not by reimplementing line breaking
// (UAX #14 - hyphens, slashes, CJK - is not something to hand-roll): the probe
// hands the file's text to the browser's own line breaker once, offscreen, in a
// replica of a real row at the real width. In the unified view that is a single
// write + read per file - lines joined by '\n' in one `pre-wrap` cell lay out to
// exactly the height the individual rows will (measured: 9449 rows predicted vs
// 9449 rendered, ~0.1ms for 4000 lines). Callers run it through queueMeasure so
// it lands off the critical path.
//
// The class constants live here rather than in DiffViewer so the probe replica
// and the real rows can't drift apart.

// ── Row classes (shared with DiffViewer's renderers) ──────────────────────────

export const UNIFIED_ROW = 'flex items-stretch'
export const UNIFIED_GUTTER = 'relative flex shrink-0 select-none'
export const UNIFIED_LINE_NUM_CLASS = 'select-none text-right pr-2 text-gray-400 dark:text-gray-600 text-xs font-mono w-10 shrink-0 border-r border-gray-200 dark:border-gray-700 leading-5'
export const UNIFIED_MARKER = 'select-none font-mono text-xs leading-5 w-4 text-center shrink-0'
export const UNIFIED_CODE_CLASS = 'pl-1 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden'

export const SBS_ROW = 'flex items-stretch divide-x divide-gray-200 dark:divide-gray-700'
export const SBS_HALF = 'flex items-start flex-1 min-w-0 group relative'
export const SBS_LINE_NUM = 'select-none text-right text-gray-400 dark:text-gray-600 text-xs font-mono w-8 shrink-0 pr-1 leading-5'
export const SBS_MARKER = 'select-none font-mono text-xs w-3 shrink-0 text-center leading-5'
export const SBS_CODE = 'pl-1 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden min-w-0'

export const EXPANDER_ROW = 'flex items-center bg-blue-50 dark:bg-blue-950/30 border-y border-blue-100 dark:border-blue-900/50 px-2 py-0.5'
export const EXPANDER_BTN = 'p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-500 cursor-pointer'
// The chevron cluster is sized for TWO buttons whether it holds one or two, so a
// file's edge expanders (one chevron) line their count up with the gap expanders
// (two) instead of sitting 18px to the left of them.
export const EXPANDER_BTNS = 'flex items-center gap-0.5 shrink-0 mr-1 w-[34px]'
// The "··· N lines ···" count is a FIXED box rather than the row's leftover
// space: as flex-1 it re-centred itself around whatever context label sat beside
// it, so the counts wandered from one expander to the next down a file. w-44
// holds a five-digit count; `shrink` lets a narrow pane squeeze it (truncating,
// never wrapping) so the row stays exactly one line tall at any width.
export const EXPANDER_COUNT = 'w-44 shrink truncate text-center text-xs text-blue-400 dark:text-blue-500 font-mono py-0.5 rounded cursor-pointer hover:bg-blue-100/50 dark:hover:bg-blue-900/30'
// The context label carries the file's own token markup, so its colours come
// from the highlight theme; the gray is only what untokenised text falls back
// to, and the opacity keeps the whole thing behind the code it labels.
export const EXPANDER_CONTEXT = 'flex-1 min-w-0 truncate pl-3 text-xs font-mono leading-5 text-gray-500 dark:text-gray-400 opacity-70'

// The two fixed-height bodies a card can render instead of rows.
export const NOTICE_BLOCK = 'px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic'
export const HIDDEN_BLOCK = 'px-4 py-8 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 italic'

// ── What a body will render ───────────────────────────────────────────────────

export interface SbsPair { old: string | null; new: string | null }

// An expander row, described precisely enough to measure: how many chevron
// buttons it carries, and the line count in its "··· N lines ···" label (null
// for the button-only expanders the windowed-hunk path renders) - so the probe
// lays out the row the component will actually render.
export interface ExpanderShape { buttons: 1 | 2; hidden: number | null }

// BodyShape is the render-path-agnostic description of a file body: which code
// lines are visible and which expander rows sit between them, or which
// fixed-height block stands in for them. DiffViewer's bodyShape() derives it
// from the same segment/hunk logic the real render uses.
export type BodyShape =
  | { kind: 'notice' }
  | { kind: 'hidden'; changed: number }
  | { kind: 'rows'; lines: string[]; expanders: ExpanderShape[] }
  | { kind: 'sbsRows'; pairs: SbsPair[]; expanders: ExpanderShape[] }

// The expander's line-count label and the hidden file's "N lines changed" line,
// spelled exactly as the components render them - at a narrow width the wrap
// depends on the real digits.
export const gapLabel = (hidden: number) => `···  ${hidden} line${hidden !== 1 ? 's' : ''}  ···`
export const hiddenLabel = (changed: number) => `${changed} lines changed`

// ── Offscreen probe ───────────────────────────────────────────────────────────

interface Probe {
  host: HTMLDivElement
  unifiedRow: HTMLDivElement
  unifiedCode: HTMLSpanElement
  sbsRow: HTMLDivElement
  sbsOld: HTMLSpanElement
  sbsNew: HTMLSpanElement
  expander: HTMLDivElement
  expanderBtn2: HTMLSpanElement
  expanderLabel: HTMLSpanElement
  notice: HTMLDivElement
  hiddenBlock: HTMLDivElement
  hiddenCount: HTMLDivElement
  ruler: HTMLSpanElement
}

let probe: Probe | null = null
let probeUnavailable = false

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Element): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  parent?.appendChild(el)
  return el
}

function buildProbe(): Probe | null {
  if (probe) return probe
  if (probeUnavailable || typeof document === 'undefined' || !document.body) return null

  const host = mk('div', '')
  // Out of flow, out of the a11y tree, and layout-contained so measuring it can
  // never invalidate the real page's layout. Not `display:none` - a hidden
  // subtree has no layout at all, which is exactly what we need it to compute.
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;contain:layout style;'

  const unifiedRow = mk('div', UNIFIED_ROW, host)
  const uGutter = mk('div', UNIFIED_GUTTER, unifiedRow)
  mk('span', UNIFIED_LINE_NUM_CLASS, uGutter).textContent = '0000'
  mk('span', UNIFIED_LINE_NUM_CLASS, uGutter).textContent = '0000'
  mk('span', UNIFIED_MARKER, unifiedRow).textContent = '+'
  const unifiedCode = mk('span', UNIFIED_CODE_CLASS, unifiedRow)

  const sbsRow = mk('div', SBS_ROW, host)
  const half = (): HTMLSpanElement => {
    const h = mk('div', SBS_HALF, sbsRow)
    const g = mk('div', UNIFIED_GUTTER, h)
    mk('span', SBS_LINE_NUM, g).textContent = '0000'
    mk('span', SBS_MARKER, h).textContent = '+'
    return mk('span', SBS_CODE, h)
  }
  const sbsOld = half()
  const sbsNew = half()

  // Expander row: only its height matters, so the replica carries the same
  // padding/border chrome and the taller of its two children (the icon buttons
  // and the "··· N lines ···" count). Neither the count nor the context label
  // beside it can wrap, so this is one line at any width - but it is still
  // measured rather than assumed, since the chrome around it is free to change.
  const expander = mk('div', EXPANDER_ROW, host)
  const btns = mk('div', EXPANDER_BTNS, expander)
  mk('span', `${EXPANDER_BTN} block`, btns).appendChild(mk('span', 'block w-3 h-3'))
  const expanderBtn2 = mk('span', `${EXPANDER_BTN} block`, btns)
  expanderBtn2.appendChild(mk('span', 'block w-3 h-3'))
  const expanderLabel = mk('span', `${EXPANDER_COUNT} block`, expander)

  const notice = mk('div', NOTICE_BLOCK, host)
  notice.textContent = 'Binary file changed'

  const hiddenBlock = mk('div', HIDDEN_BLOCK, host)
  const hiddenCount = mk('div', 'text-sm mb-2', hiddenBlock)
  mk('span', 'px-3 py-1.5 text-xs font-medium border rounded-md block', hiddenBlock).textContent = 'Load diff'

  // Advance-width ruler, taken out of flow so it can't affect the rows above.
  const ruler = mk('span', 'font-mono text-xs leading-5', host)
  ruler.style.cssText = 'position:absolute;white-space:pre;left:0;top:0;'

  document.body.appendChild(host)

  // No layout engine (jsdom under vitest) - every measurement would come back 0,
  // which would collapse every placeholder and defeat the lazy mounting.
  if (unifiedRow.getBoundingClientRect().height === 0) {
    host.remove()
    probeUnavailable = true
    return null
  }
  probe = { host, unifiedRow, unifiedCode, sbsRow, sbsOld, sbsNew, expander, expanderBtn2, expanderLabel, notice, hiddenBlock, hiddenCount, ruler }
  return probe
}

// How many characters the ruler measures at once (long enough to average out
// sub-pixel rounding, short enough to stay one line at any sane width).
const RULER_LEN = 64

// monoAdvance returns the per-character width of the code font, or 0 if the font
// in use isn't actually monospaced (a fallback could be anything) - which would
// break the "a short line can't wrap" shortcut below. Not cached: the answer
// moves with browser zoom, and it is three reads of a hidden 64-char span.
function monoAdvance(p: Probe): number {
  const width = (s: string) => { p.ruler.textContent = s.repeat(RULER_LEN); return p.ruler.getBoundingClientRect().width / RULER_LEN }
  const advance = width('0')
  const mono = advance > 0 && Math.abs(width('W') - advance) < 0.05 && Math.abs(width('i') - advance) < 0.05
  p.ruler.textContent = ''
  return mono ? advance : 0
}

// A line this simple cannot wrap: it fits the content box on its own, and holds
// nothing (tabs, wide glyphs) that would make its rendered width exceed
// length × advance.
function fitsOneRow(s: string, cols: number): boolean {
  if (s.length > cols) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c > 0x7e) return false
  }
  return true
}

// measureExpanders totals the expander rows. Identical expanders are measured
// once (a file's gaps repeat the same shapes), so this is a couple of layouts
// per file at most.
function measureExpanders(p: Probe, shapes: ExpanderShape[]): number {
  const seen = new Map<string, number>()
  let total = 0
  for (const e of shapes) {
    const key = `${e.buttons}:${e.hidden}`
    let h = seen.get(key)
    if (h === undefined) {
      p.expanderBtn2.style.display = e.buttons === 2 ? '' : 'none'
      p.expanderLabel.style.display = e.hidden == null ? 'none' : ''
      p.expanderLabel.textContent = e.hidden == null ? '' : gapLabel(e.hidden)
      h = p.expander.getBoundingClientRect().height
      seen.set(key, h)
    }
    total += h
  }
  return total
}

function contentWidth(el: HTMLElement): number {
  const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
  return el.clientWidth - pad
}

// measureBodyHeight returns the exact height a file body of this shape will lay
// out to at `width` px, or null when nothing can be measured (no DOM). `width`
// is the body's own content width - the card's inner width.
export function measureBodyHeight(width: number, shape: BodyShape): number | null {
  if (!(width > 0)) return null
  const p = buildProbe()
  if (!p) return null
  p.host.style.width = `${width}px`

  if (shape.kind === 'notice') return p.notice.getBoundingClientRect().height
  if (shape.kind === 'hidden') {
    p.hiddenCount.textContent = hiddenLabel(shape.changed)
    return p.hiddenBlock.getBoundingClientRect().height
  }

  const expandersH = measureExpanders(p, shape.expanders)

  if (shape.kind === 'rows') {
    if (shape.lines.length === 0) return expandersH
    // One write, one read: consecutive '\n'-separated lines in a pre-wrap cell
    // wrap exactly as the same lines would in one row each.
    p.unifiedCode.textContent = shape.lines.join('\n')
    const h = p.unifiedRow.getBoundingClientRect().height
    p.unifiedCode.textContent = ''
    return h + expandersH
  }

  // Side by side: a row is as tall as its taller half, so the joined-text trick
  // doesn't apply - each pair is laid out on its own. Setting both halves and
  // reading the row height gives the max for free. Pairs whose sides are both
  // too short to wrap skip the read entirely, which is most of a typical file.
  p.sbsOld.textContent = ''
  p.sbsNew.textContent = ''
  const lineH = p.sbsRow.getBoundingClientRect().height
  const advance = monoAdvance(p)
  const cols = advance > 0 ? Math.floor(contentWidth(p.sbsOld) / advance) : -1
  let h = 0
  for (const pair of shape.pairs) {
    const o = pair.old ?? ''
    const n = pair.new ?? ''
    if (cols >= 0 && fitsOneRow(o, cols) && fitsOneRow(n, cols)) { h += lineH; continue }
    p.sbsOld.textContent = o
    p.sbsNew.textContent = n
    h += p.sbsRow.getBoundingClientRect().height
  }
  p.sbsOld.textContent = ''
  p.sbsNew.textContent = ''
  return h + expandersH
}

// ── Idle queue ────────────────────────────────────────────────────────────────

// Measuring forces a layout of the probe, so a diff with hundreds of files
// shouldn't do it all during one render. Jobs drain in idle slices instead, and
// stop early if the slice runs out - the placeholders they correct are, by
// definition, not on screen yet.
const jobs = new Set<() => void>()
let flushHandle = 0
const SLICE_TAIL_MS = 2

type IdleDeadline = { timeRemaining: () => number }
const requestIdle: (cb: (d: IdleDeadline) => void) => number =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(cb, { timeout: 200 })
    // Safari has no requestIdleCallback: fall back to a macrotask with a fixed
    // budget, which drains the same queue a slice at a time.
    : (cb) => setTimeout(() => cb({ timeRemaining: () => SLICE_TAIL_MS + 6 }), 16) as unknown as number

function flush(deadline: IdleDeadline) {
  flushHandle = 0
  for (const job of jobs) {
    jobs.delete(job)
    job()
    if (deadline.timeRemaining() <= SLICE_TAIL_MS) break
  }
  if (jobs.size) schedule()
}

function schedule() {
  if (!flushHandle) flushHandle = requestIdle(flush)
}

// queueMeasure runs `job` in the next idle slice and returns a cancel function
// (safe to use as an effect cleanup).
export function queueMeasure(job: () => void): () => void {
  jobs.add(job)
  schedule()
  return () => { jobs.delete(job) }
}
