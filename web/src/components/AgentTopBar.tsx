import { useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { MoreHorizontal, ChevronDown, Sparkles, LoaderCircle } from 'lucide-react'
import { useFinePointer } from '../lib/useFinePointer'
import { Tooltip } from './Tooltip'
import { ShortcutHint } from './Kbd'
import { TILE_TONE, TILE_GLYPH } from '../lib/tileTone'
import { withBranchPills } from '../lib/branchPills'

// Visual treatment for an action button. 'primary' is a filled accent button
// (the merge call-to-action); 'segment' members are borderless and render inside
// a shared pill container; 'danger' is the red-outlined destructive button.
// Omitted → a neutral outlined button. `danger` (legacy) maps to 'danger'.
// 'primary' is a filled accent button (the merge CTA); 'segment' members are
// borderless inside a shared pill; 'danger' is the red-outlined destructive button;
// 'muted' is a quiet, non-interactive solid-grey button (the in-flight "Merging..."
// state). Omitted → a neutral outlined button.
export type AgentTopBarVariant = 'primary' | 'blue' | 'segment' | 'danger' | 'muted'

// One row of a split action's attached dropdown (the merge button's Force / Queue
// options). Rendered both in the split chevron's popover and, if the action ever
// folds into the overflow "⋯" menu, as indented sub-rows beneath it.
export interface AgentTopBarMenuItem {
  label: string
  icon?: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  // A second, muted line under the label in the (rich) dropdown - what the option
  // does. `backtick` spans become inline branch pills, the same convention the
  // toasts and dialogs use - a menu row that says "Merge into `main`" sits one
  // click from a dialog and a toast that both render that branch as a pill.
  description?: string
  // Colour of the option's icon tile in the rich dropdown. Defaults to red when
  // `danger`, else neutral.
  tone?: 'red' | 'emerald' | 'neutral'
}

export interface AgentTopBarAction {
  label: string
  // A lowlit counter hung off the label after an interpunct ("Push to MR · 1"):
  // the number qualifies the action rather than naming it, so it reads at a lower
  // weight than the verb it follows. Kept out of `label` so the accessible name,
  // the tooltip and the collapse measurement all stay the plain action.
  count?: number
  icon: ReactNode
  onClick: () => void
  variant?: AgentTopBarVariant
  danger?: boolean
  disabled?: boolean
  // Keep this action icon-only even when the toolbar has room for labels. Used
  // for secondary window/navigation actions whose tooltip carries the label.
  iconOnly?: boolean
  // Lowlit keyboard-shortcut hint (e.g. "Ctrl+M"), shown right-aligned in the
  // overflow menu and folded into a button's tooltip - only on devices with a
  // physical keyboard (see useFinePointer).
  shortcut?: string
  // When set, the action renders as a split button: its main button plus a chevron
  // that opens this dropdown (e.g. the merge button's Force merge / Queue merge).
  // `menuNote` is an optional banner above the items - a failing-tests warning.
  menu?: AgentTopBarMenuItem[]
  menuNote?: ReactNode
  // A fully custom node rendered in place of the standard button - for compound
  // controls that don't fit the button model (the armed "merges when tests pass"
  // pill, which carries its own Cancel button). `label` is still used as the key.
  render?: ReactNode
}

// Inline-rename wiring for the title. When provided, clicking the title text (or
// the menu's Rename item / F2) edits it in place; the I-beam cursor signals it's
// editable. Omitted for read-only (archived) agents.
export interface AgentTopBarRename {
  editing: boolean
  draft: string
  saving: boolean
  // True while the "Generate" button's one-shot LLM call is in flight.
  generating: boolean
  onStart: () => void
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  // Ask the backend to summarise the agent's task prompt into a title and drop
  // it into the draft (not saved until the user confirms).
  onGenerate: () => void
}

// gap between toolbar buttons / button groups, in px - used by the fit calc.
const GAP = 6
// Extra width a segment pill adds over its bare members (container padding +
// border). The off-screen measurer sizes members individually, so the budget
// calc reserves this so the chrome never tips a tight row into a clipped fit.
const SEGMENT_CHROME = 10

// Normalise the legacy `danger` flag into the variant union.
function actionVariant(a: AgentTopBarAction): AgentTopBarVariant | undefined {
  return a.variant ?? (a.danger ? 'danger' : undefined)
}

function actionBtnClass(mode: 'labels' | 'icons', a: AgentTopBarAction): string {
  const v = actionVariant(a)
  const dis = 'disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer'
  // Segment members are smaller (h-7) and borderless - the pill frames them.
  if (v === 'segment') {
    const shape = mode === 'labels' ? 'gap-1.5 px-2.5' : 'w-7'
    return `shrink-0 h-7 inline-flex items-center justify-center rounded-md text-xs font-semibold transition-colors ${dis} ${shape} bg-transparent text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100`
  }
  const base = `shrink-0 h-8 inline-flex items-center justify-center rounded-lg text-sm font-semibold transition-colors ${dis}`
  const shape = mode === 'labels' ? 'gap-1.5 px-3' : 'w-8'
  if (v === 'primary') {
    return `${base} ${shape} bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-700/30 shadow-sm`
  }
  // 'blue' is the Create MR CTA: a distinct forge-publish colour, set apart from
  // Merge's green so the two primary actions read as different things.
  if (v === 'blue') {
    return `${base} ${shape} bg-blue-600 hover:bg-blue-500 text-white border border-blue-700/30 shadow-sm`
  }
  // 'muted' is the in-flight "Merging..." state: a solid quiet grey, not dimmed (so it
  // reads as deliberately inert rather than a disabled CTA), and non-interactive.
  if (v === 'muted') {
    return `shrink-0 h-8 inline-flex items-center justify-center rounded-lg text-sm font-semibold ${shape} cursor-default bg-gray-100 dark:bg-[#1c2330] text-gray-400 dark:text-[#8b94a6] border border-gray-200 dark:border-[#2e3747]`
  }
  if (v === 'danger') {
    return `${base} ${shape} bg-white dark:bg-gray-800 border border-red-300 dark:border-red-800/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20`
  }
  return `${base} ${shape} bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700`
}

// The pill that frames a contiguous run of 'segment' actions (see the mockup's
// Unread/Rename group). p-0.5 over h-7 members lands the pill at the h-8 height
// of its primary/danger neighbours.
const segmentGroupClass =
  'shrink-0 inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600'

const moreBtnClass =
  'shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer'

// ActionLabel is a button's text: the action, plus a lowlit count when the
// action carries one, hung off an interpunct - the same separator the test chips
// use (✓ 142 · ⚠ 4). Brackets read as an aside about the label; a dot reads as a
// second field beside it, which is what a commit count is. The count is dimmed
// rather than sized down so it keeps the label's baseline and the button height,
// and "Push to MR · 1" stays one line where only the number recedes.
function ActionLabel({ a }: { a: AgentTopBarAction }) {
  return (
    <span className="whitespace-nowrap optical-center">
      {a.label}
      {a.count != null && <span className="ml-1.5 font-normal opacity-60">· {a.count}</span>}
    </span>
  )
}

// Render a single action button.
function ActionButton({ a, mode, showShortcut }: { a: AgentTopBarAction; mode: 'labels' | 'icons'; showShortcut: boolean }) {
  const effectiveMode = a.iconOnly ? 'icons' : mode
  const shortcut = showShortcut && a.shortcut ? { keys: a.shortcut.split('+') } : undefined
  return (
    // shrink-0 rides the wrapper too: it is now the toolbar row's flex child.
    <Tooltip content={a.label} shortcut={shortcut} side="bottom" className="shrink-0">
      <button
        type="button"
        disabled={a.disabled}
        onClick={a.onClick}
        aria-label={a.label}
        className={actionBtnClass(effectiveMode, a)}
      >
        {a.icon}
        {effectiveMode === 'labels' && <ActionLabel a={a} />}
      </button>
    </Tooltip>
  )
}

// The chevron half of a split button: it mirrors the main button's variant skin
// but rounds on the right and drops its left border so the two read as one control.
function chevBtnClass(v: AgentTopBarVariant | undefined): string {
  const base = 'shrink-0 h-8 px-1 inline-flex items-center justify-center rounded-r-lg border border-l-0 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
  if (v === 'primary') return `${base} bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-700/40`
  if (v === 'blue') return `${base} bg-blue-600 hover:bg-blue-500 text-white border-blue-700/40`
  if (v === 'danger') return `${base} bg-white dark:bg-gray-800 border-red-300 dark:border-red-800/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20`
  return `${base} bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700`
}

// A rounded icon tile for a rich dropdown row. The SAME object as a toast's tile
// and a dialog's, so it draws from the same table (lib/tileTone) - these rows sit
// one click away from the dialog they open, and the two tiles reading differently
// was the giveaway that they were two hand-rolled tints. Slightly smaller (8 vs 9)
// because a menu row is denser than a card header; the border is gone with the
// tint, since a solid fill does not need an edge to separate it from the sheet.
function MenuTile({ tone, children }: { tone: 'red' | 'emerald' | 'neutral'; children: ReactNode }) {
  return (
    <span className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${TILE_GLYPH} ${TILE_TONE[tone]}`}>
      {children}
    </span>
  )
}

// A split action button: the main button (the action's onClick) butted against a
// chevron that opens the action's `menu` dropdown - used for the merge button's
// Force merge / Queue merge options, with an optional warning note on top.
function SplitActionButton({ a, mode, showShortcut }: { a: AgentTopBarAction; mode: 'labels' | 'icons'; showShortcut: boolean }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])
  const v = actionVariant(a)
  // Reuse the action skin but square off the main button's right edge so it meets
  // the chevron seamlessly.
  const mainCls = actionBtnClass(mode, a).replace('rounded-lg', 'rounded-l-lg rounded-r-none')
  return (
    <div ref={wrapRef} className="relative inline-flex shrink-0">
      <Tooltip content={a.label} shortcut={showShortcut && a.shortcut ? { keys: a.shortcut.split('+') } : undefined} side="bottom" className="shrink-0">
        <button
          type="button"
          disabled={a.disabled}
          onClick={a.onClick}
          aria-label={a.label}
          className={mainCls}
        >
          {a.icon}
          {mode === 'labels' && <ActionLabel a={a} />}
        </button>
      </Tooltip>
      <button
        type="button"
        disabled={a.disabled}
        aria-label={`${a.label} options`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={chevBtnClass(v)}
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && a.menu && (
        <div className="absolute right-0 top-full mt-1.5 w-max min-w-[15rem] max-w-[22rem] bg-white dark:bg-[#141a26] border border-gray-200 dark:border-[#252d3b] rounded-xl shadow-xl z-50 p-1.5">
          {a.menuNote && (
            <div className="px-2.5 py-2 mb-1 text-xs border-b border-gray-100 dark:border-[#232b3a]">{a.menuNote}</div>
          )}
          {a.menu.map((m) => (
            <button
              key={m.label}
              type="button"
              disabled={m.disabled}
              onClick={() => {
                setOpen(false)
                m.onClick()
              }}
              className="w-full flex items-start gap-3 px-2.5 py-2 rounded-lg text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5"
            >
              <MenuTile tone={m.tone ?? (m.danger ? 'red' : 'neutral')}>{m.icon}</MenuTile>
              <span className="flex flex-col gap-0.5 min-w-0 pt-0.5">
                <span className={`text-sm font-semibold leading-tight ${m.danger ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-[#eef1f6]'}`}>{m.label}</span>
                {m.description && <span className="text-xs leading-snug text-gray-500 dark:text-[#8b94a6]">{withBranchPills(m.description)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Walk a visible action list, wrapping each contiguous run of 'segment' actions
// in the shared pill while standalone actions render bare. An action with a `menu`
// renders as a split button.
function renderActions(list: AgentTopBarAction[], mode: 'labels' | 'icons', showShortcut: boolean): ReactNode[] {
  const out: ReactNode[] = []
  for (let i = 0; i < list.length; ) {
    if (actionVariant(list[i]) === 'segment') {
      const group: AgentTopBarAction[] = []
      while (i < list.length && actionVariant(list[i]) === 'segment') group.push(list[i++])
      out.push(
        <div key={`seg-${group[0].label}`} className={segmentGroupClass}>
          {group.map((g) => (
            <ActionButton key={g.label} a={g} mode={mode} showShortcut={showShortcut} />
          ))}
        </div>,
      )
    } else if (list[i].render) {
      out.push(<div key={list[i].label} className="shrink-0">{list[i].render}</div>)
      i++
    } else if (list[i].menu) {
      out.push(<SplitActionButton key={list[i].label} a={list[i]} mode={mode} showShortcut={showShortcut} />)
      i++
    } else {
      out.push(<ActionButton key={list[i].label} a={list[i]} mode={mode} showShortcut={showShortcut} />)
      i++
    }
  }
  return out
}

// An action toolbar that adapts to the space the header gives it: show every
// action as an icon+label button when it all fits, fall back to icon-only when
// it doesn't, and once even the icons won't fit, fold the lowest-priority ones
// (from the right) into an overflow "⋯" menu that sits after the buttons. The
// title has priority over the buttons: we reserve its full (untruncated) width
// first, so the buttons collapse into the menu before the title ever truncates -
// only a title long enough to fill the bar (leaving just room for the "⋯" button)
// starts to truncate. All widths are measured off-screen, so the fit is exact
// rather than breakpoint-guessed and never leaves a half-clipped button.
function AdaptiveActions({
  actions,
  title,
  showShortcut,
  reserve = 0,
}: {
  actions: AgentTopBarAction[]
  title: string
  showShortcut: boolean
  // Extra px in the row that isn't the title or the toolbar and must be kept
  // clear - the rename box's "Generate" button, which only exists while editing.
  reserve?: number
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const labeledRefs = useRef<(HTMLElement | null)[]>([])
  const iconRefs = useRef<(HTMLElement | null)[]>([])
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const titleMeasureRef = useRef<HTMLButtonElement | null>(null)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const [vis, setVis] = useState<{ mode: 'labels' | 'icons'; count: number }>({ mode: 'icons', count: actions.length })
  const [menuOpen, setMenuOpen] = useState(false)

  // The only thing recompute needs from the actions' contents (beyond count and
  // the measured widths) is how many contiguous runs of segment actions there are,
  // each of which reserves pill chrome. Derive it here as a primitive so recompute
  // closes over plain numbers, not the fresh-every-render `actions` array.
  const n = actions.length
  let segmentGroups = 0
  for (let i = 0; i < n; i++) {
    if (actionVariant(actions[i]) === 'segment' && (i === 0 || actionVariant(actions[i - 1]) !== 'segment')) segmentGroups++
  }

  const recompute = useCallback(() => {
    // Measure against the parent row (title + toolbar). Read via parentElement
    // rather than an ancestor-supplied ref: ancestor refs attach after this
    // child's layout effect, so a passed ref would still be null on first measure.
    const cont = rootRef.current?.parentElement
    if (!cont) return
    const labeled = labeledRefs.current.slice(0, n).map((b) => b?.offsetWidth ?? 0)
    const icons = iconRefs.current.slice(0, n).map((b) => b?.offsetWidth ?? 0)
    const more = moreRef.current?.offsetWidth ?? 28
    // +1 guards against sub-pixel rounding triggering an unwanted ellipsis.
    const titleNatural = (titleMeasureRef.current?.offsetWidth ?? 0) + 1
    // Bail until the off-screen measurer has laid out (avoids a 0-width pass).
    if (labeled.length < n || labeled.some((w) => w === 0)) return
    // Reserve the title's full width first - but never more than leaves room for
    // the "⋯" button, so a pathologically long title still yields the menu.
    const titleReserve = Math.min(titleNatural, Math.max(0, cont.clientWidth - more - GAP))
    // Reserve the pill chrome around each contiguous run of segment actions (count
    // derived above) - the measurer sizes members bare, so this keeps a row honest.
    const budget = Math.max(0, cont.clientWidth - titleReserve - GAP - reserve - segmentGroups * SEGMENT_CHROME)
    const span = (arr: number[], k: number) => arr.slice(0, k).reduce((a, b) => a + b, 0) + Math.max(0, k - 1) * GAP
    let next: { mode: 'labels' | 'icons'; count: number }
    if (span(labeled, n) <= budget) {
      next = { mode: 'labels', count: n }
    } else if (span(icons, n) <= budget) {
      next = { mode: 'icons', count: n }
    } else {
      // Icon-only with overflow: greedily keep the highest-priority icons that
      // fit alongside the reserved "⋯" button; the rest fold into the menu.
      let used = 0
      let k = 0
      for (let i = 0; i < n; i++) {
        const add = icons[i] + (i > 0 ? GAP : 0)
        if (used + add + GAP + more <= budget) {
          used += add
          k = i + 1
        } else break
      }
      next = { mode: 'icons', count: k }
    }
    setVis((prev) => (prev.mode === next.mode && prev.count === next.count ? prev : next))
  }, [n, segmentGroups, reserve])

  // Measure + recompute before paint, and on every container resize. This reads
  // the committed layout of the off-screen sizers, so the measure-then-setState
  // must happen in a layout effect (it can't be derived during render).
  useLayoutEffect(() => {
    recompute()
    const cont = rootRef.current?.parentElement
    if (!cont || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => recompute())
    ro.observe(cont)
    // Also refit when the title's measured width changes (a new title, or a font
    // load) - that doesn't resize the container, so the container observer alone
    // would miss it; this replaces carrying `title` as a recompute dependency.
    if (titleMeasureRef.current) ro.observe(titleMeasureRef.current)
    return () => ro.disconnect()
  }, [recompute])

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menuOpen])

  const count = Math.min(vis.count, actions.length)
  const visible = actions.slice(0, count)
  const hidden = actions.slice(count)
  const overflow = hidden.length > 0

  return (
    <div ref={rootRef} className="shrink-0 flex items-center gap-1.5">
      {renderActions(visible, vis.mode, showShortcut)}

      {overflow && (
        // flex (not the default block) so the button doesn't pick up a line-box
        // descender gap that would ride it a couple px above its sibling buttons.
        <div ref={menuWrapRef} className="relative flex items-center">
          <button
            type="button"
            aria-label="More actions"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className={moreBtnClass}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
              {hidden.map((a) => (
                <div key={a.label}>
                  <button
                    type="button"
                    disabled={a.disabled}
                    onClick={() => {
                      setMenuOpen(false)
                      a.onClick()
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                      actionVariant(a) === 'danger'
                        ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                        : actionVariant(a) === 'primary'
                          ? 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                          : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    <span className="shrink-0">{a.icon}</span>
                    {a.label}
                    {showShortcut && a.shortcut && (
                      <span className="ml-auto pl-6"><ShortcutHint keys={a.shortcut.split('+')} /></span>
                    )}
                  </button>
                  {/* A split action that folded into the overflow menu keeps its
                      dropdown options as indented sub-rows so Force / Queue stay
                      reachable on a narrow viewport. */}
                  {a.menu?.map((m) => (
                    <button
                      key={m.label}
                      type="button"
                      disabled={m.disabled}
                      onClick={() => {
                        setMenuOpen(false)
                        m.onClick()
                      }}
                      className={`w-full flex items-center gap-2.5 pl-8 pr-3 py-2 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                        m.danger
                          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                      }`}
                    >
                      {m.icon && <span className="shrink-0">{m.icon}</span>}
                      {m.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Off-screen measurer: a labeled and an icon-only copy of every button (plus
          the "⋯" button) so recompute() can read their natural widths. invisible +
          absolute keeps it out of flow and unpainted; whitespace-nowrap stops the
          labels wrapping so the measured widths are the real single-line widths. */}
      <div aria-hidden className="invisible pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1.5">
        {actions.map((a, i) => (
          <span key={`l-${a.label}`} ref={(el) => { labeledRefs.current[i] = el }} className="shrink-0 inline-flex">
            {a.render ?? (
              <button className={actionBtnClass(a.iconOnly ? 'icons' : 'labels', a)} tabIndex={-1}>
                {a.icon}
                {!a.iconOnly && <ActionLabel a={a} />}
                {/* Reserve the split chevron's width so the fit calc accounts for it. */}
                {a.menu && <span className="inline-block w-7" />}
              </button>
            )}
          </span>
        ))}
        {actions.map((a, i) => (
          <span key={`i-${a.label}`} ref={(el) => { iconRefs.current[i] = el }} className="shrink-0 inline-flex">
            {a.render ?? (
              <button className={actionBtnClass('icons', a)} tabIndex={-1}>
                {a.icon}
                {a.menu && <span className="inline-block w-7" />}
              </button>
            )}
          </span>
        ))}
        <button ref={moreRef} className={moreBtnClass} tabIndex={-1}>
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {/* Natural (untruncated) title width - mirrors the real title button's font
            + padding but sizes to content, so recompute() can reserve its space. */}
        <button ref={titleMeasureRef} className="text-sm font-semibold px-1 py-1 whitespace-nowrap" tabIndex={-1}>
          {title}
        </button>
      </div>
    </div>
  )
}

// The agent page's share of the global top bar (rendered into __root's slot via
// TopBarPortal): the agent name (click / F2 to rename) with an adaptive row of
// action buttons on the right and a status dot. The actions collapse
// responsively (labels → icons → overflow menu) so they never spill out of the
// bar.
export function AgentTopBarContent({
  statusDot,
  title,
  actions,
  rename,
}: {
  title: string
  statusDot?: ReactNode
  actions: AgentTopBarAction[]
  rename?: AgentTopBarRename
}) {
  // Only surface keyboard hints on devices that actually have a keyboard.
  const showShortcut = useFinePointer()

  const editing = rename?.editing ?? false
  // What the title box currently shows: the live draft while editing, else the
  // saved title. AdaptiveActions still measures the SAVED title, so the toolbar
  // doesn't re-collapse on every keystroke of a rename.
  const displayed = editing && rename ? rename.draft : title

  // When editing is triggered without a click (F2 / the menu's Rename item),
  // focus + select the field. A click already focuses it and positions the
  // caret where the user clicked, so we skip select() in that case (the input
  // is already the active element by the time this runs) to preserve the caret.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (el && document.activeElement !== el) {
      el.focus()
      el.select()
    }
  }, [editing])

  // The Generate button lives between the title box and the toolbar, so its
  // width has to come out of the toolbar's collapse budget or the row would
  // over-subscribe and eat into the title. Measure it rather than hardcoding a
  // px guess, since the label's width follows the font.
  const genRef = useRef<HTMLDivElement>(null)
  const [genReserve, setGenReserve] = useState(0)
  useLayoutEffect(() => {
    const el = genRef.current
    if (!el) {
      setGenReserve(0)
      return
    }
    const measure = () => setGenReserve(el.offsetWidth + GAP)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [editing])

  return (
    <>
      {/* Status cluster (the dot) sits just before the agent's name - kept
          OUTSIDE the measured title/actions row so its width doesn't confuse
          AdaptiveActions' collapse budget. */}
      {statusDot && <div className="shrink-0 flex items-center gap-2">{statusDot}</div>}

      {/* Title + adaptive actions share this row; the title flexes/truncates so
          the toolbar always has room to lay out. AdaptiveActions measures this
          row via its own parentElement, so the row needs no ref. */}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        {rename ? (
          // A single always-mounted input (read-only until editing) so the box
          // keeps its full width, clicking places the caret where you click, and
          // the text never shifts between the display and edit states. The bottom
          // border is always reserved (transparent → blue) to avoid any reflow.
          //
          // flex-1: the box claims every px the row has left once the toolbar
          // (and, while editing, the Generate button) have taken theirs - both of
          // which are shrink-0, so growing here can never squeeze them out.
          // size={1} keeps the input's intrinsic 20-character width out of the
          // row's min-content, so a narrow viewport shrinks the box rather than
          // overflowing the bar.
          <Tooltip content={editing ? undefined : 'Rename'} shortcut={editing ? undefined : { keys: ['F2'] }} side="bottom" className="min-w-0 flex-1">
            <input
              ref={inputRef}
              type="text"
              size={1}
              aria-label="Agent title"
              value={displayed}
              readOnly={!editing}
              disabled={rename.saving}
              onChange={(e) => rename.onChange(e.target.value)}
              onFocus={() => {
                if (!editing) rename.onStart()
              }}
              onBlur={() => {
                if (editing && !rename.saving) rename.onSave()
              }}
              onKeyDown={(e) => {
                if (!editing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  rename.onSave()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  rename.onCancel()
                }
              }}
              className={`min-w-0 flex-1 text-sm font-semibold bg-transparent border-b px-1 py-1 rounded focus:outline-none text-gray-800 dark:text-gray-100 transition-colors disabled:opacity-50 ${
                editing
                  ? 'border-blue-400'
                  : 'border-transparent cursor-text hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            />
          </Tooltip>
        ) : (
          <span
            title={title}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800 dark:text-gray-100 px-1 py-1"
          >
            {title}
          </span>
        )}

        {rename && editing && (
          // onMouseDown-preventDefault: the input saves and closes on blur, so
          // without this the click would commit the rename before it lands.
          <div ref={genRef} className="shrink-0 flex items-center">
            <Tooltip content="Write a title from this agent's task" side="bottom" className="shrink-0">
              <button
                type="button"
                disabled={rename.generating || rename.saving}
                onMouseDown={(e) => e.preventDefault()}
                onClick={rename.onGenerate}
                className="shrink-0 h-7 inline-flex items-center gap-1.5 px-2.5 rounded-md text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-gray-100 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
              >
                {rename.generating ? (
                  <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  // Filled, not outlined. At 14px lucide's Sparkles is three
                  // hairline outlines and reads as noise next to the solid label
                  // beside it; filled, the mark reads as a mark. The other
                  // Sparkles in the UI are still outlined - see the icon audit.
                  <Sparkles className="w-3.5 h-3.5" fill="currentColor" />
                )}
                <span className="whitespace-nowrap optical-center">Generate</span>
              </button>
            </Tooltip>
          </div>
        )}

        {actions.length > 0 && (
          <AdaptiveActions actions={actions} title={title} showShortcut={showShortcut} reserve={genReserve} />
        )}
      </div>

    </>
  )
}
