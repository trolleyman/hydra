import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Braces, Check, ChevronRight, Copy, Folder, FolderOpen, SkipForward, SquareArrowOutUpRight, SquareFunction, X } from 'lucide-react'
import type { TestCase } from '../api/models/TestCase'
import { caseKey, caseLocation, splitPath } from '../lib/testCases'
import { getFileIcon } from '../lib/fileIcons'

// CaseTree renders test cases as a collapsible location tree (TESTS_PLAN.md
// Feature 1), built from each case's structured location:
//   - by path (default): dir/dir/file segments, then the scope chain
//     (describe/class levels) inside the file;
//   - by scope (useScope): the class chain alone, with file:line shown as a
//     dim secondary affordance on the leaf.
// The tree is built from ALL of a runner's cases but renders only the
// `visible` ones (post status-filter/search): node badges therefore always
// tally everything under a node, while hidden rows — and subtrees with
// nothing visible — stay out of the way.
// Two densification rules keep it shallow: a chain of single-child folders
// merges into one row (internal/artifacts — like VS Code compact folders), and
// a subtree holding exactly ONE case collapses the whole chain into that
// case's row, prefixed with the chain (so a lone warning isn't five expanders
// deep). Each row carries per-segment icons (folder / file for path levels,
// {} module vs ƒ function for scope levels), a hover copy button (repo-relative
// path or path:line) and a hover "open in repository" affordance that
// deep-links to the file/dir (and line) in the repo browser. Cases with no
// location (old cached reports, exit-code fallbacks) land at the root as flat
// rows.

type SegKind = 'path' | 'scope'
// A scope level is either a container (a describe block / class / suite) or a
// Go test function that owns subtests — the backend tags this per level
// (TestCase.scope_kinds), since the strings alone can't tell TestClass (a
// pytest class) from TestFoo (a Go func).
type ScopeKind = 'module' | 'function'
type Seg = { label: string; kind: SegKind; scopeKind?: ScopeKind }

// OpenInRepo deep-links a row to the repository browser (the file/dir — and, for
// a case, its line — at the tested ref). Undefined when there's no ref to browse
// (see TestsPanel), which hides the affordance entirely.
export type OpenInRepo = (path: string, line?: number | null) => void

function normScopeKind(k: string | null | undefined): ScopeKind {
  return k === 'function' ? 'function' : 'module'
}

function caseSegs(c: TestCase, useScope: boolean): Seg[] {
  const path: Seg[] = splitPath(c.path).map((label) => ({ label, kind: 'path' as const }))
  const kinds = c.scope_kinds ?? []
  const scope: Seg[] = (c.scope ?? []).map((label, i) => ({ label, kind: 'scope' as const, scopeKind: normScopeKind(kinds[i]) }))
  if (useScope) return scope.length > 0 ? scope : path
  return [...path, ...scope]
}

type TreeNode = {
  label: string // joined display label (used for sorting + copy fallback)
  kind: SegKind
  // The display segments this row shows: one seg per node, or the whole merged
  // chain once compact() folds single-child chains together. Preserving the
  // per-segment kind (path vs scope, module vs function) is what lets a merged
  // "auth/rotation.test.ts › key rotation" row lead with a file icon and mark
  // the scope level with its own glyph.
  segs: Seg[]
  // Real path segments accumulated from the root through this node (path-kind
  // segments only) — the copyable repo-relative path.
  pathParts: string[]
  key: string // stable identity for the collapse set
  children: Map<string, TreeNode>
  cases: TestCase[] // cases attached directly at this node (all, incl. hidden)
  visCases: TestCase[] // the filter-surviving subset of `cases`
  counts: Record<string, number> // per-status tallies over ALL cases in the subtree
  total: number
  visTotal: number // filter-surviving cases in the subtree; 0 → node not rendered
}

function newNode(seg: Seg | null, pathParts: string[], key: string): TreeNode {
  return {
    label: seg?.label ?? '',
    kind: seg?.kind ?? 'path',
    segs: seg ? [seg] : [],
    pathParts, key, children: new Map(), cases: [], visCases: [], counts: {}, total: 0, visTotal: 0,
  }
}

function buildTree(cases: TestCase[], visibleSet: Set<TestCase>, useScope: boolean): TreeNode {
  const root = newNode(null, [], '')
  for (const c of cases) {
    const vis = visibleSet.has(c)
    let node = root
    node.total++
    if (vis) node.visTotal++
    node.counts[c.status] = (node.counts[c.status] ?? 0) + 1
    for (const seg of caseSegs(c, useScope)) {
      const childKey = `${node.key}/${seg.label}`
      let child = node.children.get(childKey)
      if (!child) {
        child = newNode(seg, seg.kind === 'path' ? [...node.pathParts, seg.label] : node.pathParts, childKey)
        node.children.set(childKey, child)
      }
      node = child
      node.total++
      if (vis) node.visTotal++
      node.counts[c.status] = (node.counts[c.status] ?? 0) + 1
    }
    node.cases.push(c)
    if (vis) node.visCases.push(c)
  }
  compact(root)
  return root
}

// compact merges every childless-of-cases single-child chain into one row:
// internal → artifacts becomes "internal/artifacts" (path segments join with
// "/", scope levels with "›"). The merged node keeps the DEEPEST child's key,
// so its collapse state survives re-renders that change the chain above it, and
// concatenates the segment lists so each level keeps its own icon.
function compact(node: TreeNode): void {
  for (let child of [...node.children.values()]) {
    node.children.delete(child.key)
    while (child.cases.length === 0 && child.children.size === 1) {
      const only = [...child.children.values()][0]
      only.label = `${child.label}${only.kind === 'path' ? '/' : ' › '}${only.label}`
      only.segs = [...child.segs, ...only.segs]
      child = only
    }
    compact(child)
    node.children.set(child.key, child)
  }
}

// nodeIsDir distinguishes a directory (holds further path segments) from a file
// (its children are scope levels, or it holds cases directly). Drives the
// folder-vs-file icon on the leading path group.
function nodeIsDir(node: TreeNode): boolean {
  for (const c of node.children.values()) if (c.kind === 'path') return true
  return false
}

// hoistedCase returns the single case of a one-case subtree along with the
// merged chain of segments leading to it, or null when the subtree holds more
// than one. Only a subtree whose FULL total is one hoists: with hidden siblings
// the node keeps its expandable row so the everything-counted badges have a home.
function hoistedCase(node: TreeNode): { c: TestCase; segs: Seg[] } | null {
  if (node.total !== 1 || node.visTotal !== 1) return null
  const segs: Seg[] = [...node.segs]
  let cur = node
  while (cur.cases.length === 0) {
    const next: TreeNode | undefined = [...cur.children.values()][0]
    if (!next) return null
    segs.push(...next.segs)
    cur = next
  }
  return { c: cur.cases[0], segs }
}

// segText joins a segment chain the way the tree merges labels: path→path with
// "/", anything into a scope level with " › ". Used for the copy fallback.
function segText(segs: Seg[]): string {
  return segs.map((s, i) => (i === 0 ? s.label : `${s.kind === 'path' ? '/' : ' › '}${s.label}`)).join('')
}

// filenameOf returns the trailing file name of a (possibly merged) path label
// like "internal/git/commit_test.go" → "commit_test.go".
function filenameOf(label: string): string {
  return label.split('/').pop() ?? label
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

const STATUS_RENDER_ORDER = ['failed', 'warning', 'passed', 'skipped']

function statusRank(s: string): number {
  const i = STATUS_RENDER_ORDER.indexOf(s)
  return i === -1 ? STATUS_RENDER_ORDER.length : i
}

// TreeGuide is the lowlit vertical line dropped from an expanded node's
// chevron through its children, so every row shows which parent it belongs
// to. Rendered inside a `relative` wrapper around the children block; `depth`
// is the expanded PARENT's depth (the line lands under its chevron).
export function TreeGuide({ depth }: { depth: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-0 bottom-0 w-px bg-gray-200/80 dark:bg-gray-700/50"
      style={{ left: depth * 14 + 13 }}
    />
  )
}

// NodeBadges shows a node's mixed per-status tallies (✓142 ⚠4 ✗2), omitting
// zero buckets. In the tests tree these count EVERYTHING under the node —
// the status filter and search hide rows, never the tallies.
export function NodeBadges({ counts }: { counts: Record<string, number> }) {
  return (
    <span className="ml-auto flex items-center gap-1.5 shrink-0 text-[10px] font-medium tabular-nums">
      {(counts.failed ?? 0) > 0 && (
        <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400"><X className="w-2.5 h-2.5" strokeWidth={3} />{counts.failed}</span>
      )}
      {(counts.warning ?? 0) > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"><AlertTriangle className="w-2.5 h-2.5" />{counts.warning}</span>
      )}
      {(counts.passed ?? 0) > 0 && (
        <span className="inline-flex items-center gap-0.5 text-green-700 dark:text-green-400"><Check className="w-2.5 h-2.5" strokeWidth={3} />{counts.passed}</span>
      )}
      {(counts.skipped ?? 0) > 0 && (
        <span className="inline-flex items-center gap-0.5 text-gray-400 dark:text-gray-500"><SkipForward className="w-2.5 h-2.5" />{counts.skipped}</span>
      )}
    </span>
  )
}

// CopyButton is the hover-revealed copy affordance on dir/case rows.
function CopyButton({ text, title }: { text: string; title: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); copyText(text) }}
      title={title}
      aria-label={title}
      className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-opacity cursor-pointer"
    >
      <Copy className="w-3 h-3" />
    </button>
  )
}

// RepoLinkButton is the hover-revealed "open in the repository browser"
// affordance, deep-linking a row to its file/dir (and line) at the tested ref.
function RepoLinkButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      aria-label={title}
      className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-gray-400 hover:text-blue-600 dark:text-gray-500 dark:hover:text-blue-400 transition-opacity cursor-pointer"
    >
      <SquareArrowOutUpRight className="w-3 h-3" />
    </button>
  )
}

function StatusGlyph({ status }: { status: string }) {
  switch (status) {
    case 'failed':
      return <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" strokeWidth={3} />
    case 'warning':
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
    case 'skipped':
      return <SkipForward className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
    default:
      return <Check className="w-3.5 h-3.5 text-green-600 shrink-0" strokeWidth={3} />
  }
}

function FileGlyph({ name }: { name: string }) {
  const { Icon, className } = getFileIcon(name)
  return <Icon className={`w-3.5 h-3.5 shrink-0 ${className}`} />
}

// ScopeGlyph draws a scope level: a function glyph (ƒ, violet) for a Go test
// function that owns subtests, or a braces glyph ({ }, teal) for a container —
// a describe block, class or suite (the default when the kind is unknown).
function ScopeGlyph({ scopeKind }: { scopeKind?: ScopeKind }) {
  return scopeKind === 'function'
    ? <SquareFunction className="w-3.5 h-3.5 text-violet-500 dark:text-violet-400 shrink-0" />
    : <Braces className="w-3.5 h-3.5 text-teal-500 dark:text-teal-400 shrink-0" />
}

// RowSegments renders a location chain as a sequence of icon+label pieces
// separated by "›": the leading path segments collapse into ONE file/folder
// piece (the folder open when expanded), then each scope level is its own
// module/function piece. So "auth/rotation.test.ts › key rotation" reads as a
// file icon + "auth/rotation.test.ts" then a module glyph + "key rotation".
function RowSegments({ segs, isDir, expanded }: { segs: Seg[]; isDir: boolean; expanded: boolean }) {
  const pathSegs = segs.filter((s) => s.kind === 'path')
  const scopeSegs = segs.filter((s) => s.kind === 'scope')
  const pieces: { icon: ReactNode; text: string; textClass: string }[] = []
  if (pathSegs.length > 0) {
    const icon = isDir
      ? (expanded ? <FolderOpen className="w-3.5 h-3.5 text-blue-500 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />)
      : <FileGlyph name={filenameOf(pathSegs[pathSegs.length - 1].label)} />
    pieces.push({ icon, text: pathSegs.map((s) => s.label).join('/'), textClass: 'text-gray-700 dark:text-gray-300' })
  }
  for (const s of scopeSegs) {
    pieces.push({ icon: <ScopeGlyph scopeKind={s.scopeKind} />, text: s.label, textClass: 'italic text-gray-500 dark:text-gray-400' })
  }
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {pieces.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="shrink-0 text-xs text-gray-300 dark:text-gray-600">›</span> : null}
          {p.icon}
          <span className={`font-mono text-xs truncate min-w-0 ${p.textClass}`}>{p.text}</span>
        </Fragment>
      ))}
    </span>
  )
}

// CaseRow renders one test case: for a hoisted one-case subtree it leads with
// the file icon + the (non-lowlit) location chain, then the status glyph
// immediately before the leaf name; a plain leaf row leads with the status
// glyph. Both carry the message box for failing/warning cases, duration, a copy
// affordance, an open-in-repo affordance, and — in scope mode — the file:line
// secondary so the diff deep-link survives the axis switch.
export function CaseRow({ c, segs, showLocation, indent = 0, onOpenInRepo }: {
  c: TestCase
  // The merged segment chain leading here when this row was hoisted out of a
  // one-case subtree (rendered before the leaf name, icons and all).
  segs?: Seg[]
  // Show the case's path:line inline (scope-mode leaves, flat lists).
  showLocation?: boolean
  indent?: number
  onOpenInRepo?: OpenInRepo
}) {
  const failedish = c.status === 'failed' || c.status === 'warning'
  // Skipped cases show their message too (the skip reason, dimmed) — skipped is
  // treated like every other status, not a mute roll-up.
  const showMessage = !!c.message && (failedish || c.status === 'skipped')
  const loc = caseLocation(c)
  const prefix = segs ? segText(segs) : ''
  const copyable = loc || (prefix ? `${prefix} › ${c.name}` : c.name)
  const boxTone = c.status === 'failed'
    ? 'bg-red-50/40 dark:bg-red-900/10'
    : c.status === 'warning' ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''
  const msgTone = c.status === 'failed'
    ? 'text-red-700 dark:text-red-300 bg-red-100/50 dark:bg-red-900/20 border-red-200/60 dark:border-red-900/40'
    : c.status === 'warning'
      ? 'text-amber-700 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-900/20 border-amber-200/60 dark:border-amber-900/40'
      : 'text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 border-gray-200/60 dark:border-gray-700/60'

  return (
    <div className={`group flex flex-col gap-1.5 py-1.5 pr-3 ${boxTone}`} style={{ paddingLeft: `${indent * 14 + 12}px` }}>
      <div className="flex items-center gap-1.5 min-w-0">
        {segs ? (
          <>
            <RowSegments segs={segs} isDir={false} expanded={false} />
            {/* The status glyph sits right before the leaf test name, after the
                location chain. */}
            <span className="shrink-0 text-xs text-gray-300 dark:text-gray-600">›</span>
          </>
        ) : null}
        <StatusGlyph status={c.status} />
        <span className={`font-mono text-xs min-w-0 truncate ${failedish ? 'font-medium' : 'text-gray-600 dark:text-gray-400'}`}>
          {c.name}
        </span>
        {showLocation && loc ? (
          <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500 truncate shrink-1">{loc}</span>
        ) : c.line != null && c.line > 0 ? (
          // Path mode already shows the file in the tree, so just the line — a dim
          // ":42" — which is also the row's open-in-repo #L target.
          <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500 shrink-0">:{c.line}</span>
        ) : null}
        <CopyButton text={copyable} title={loc ? `Copy ${loc}` : 'Copy test name'} />
        {onOpenInRepo && c.path ? (
          <RepoLinkButton onClick={() => onOpenInRepo(c.path as string, c.line)} title={`Open ${loc || c.path} in repository`} />
        ) : null}
        {c.duration_ms != null && c.duration_ms > 0 ? (
          <span className="ml-auto font-mono text-[10px] text-gray-400 shrink-0">{c.duration_ms}ms</span>
        ) : null}
      </div>
      {showMessage ? (
        <pre className={`ml-5 text-[11px] font-mono whitespace-pre-wrap border rounded px-2.5 py-1.5 ${msgTone}`}>{c.message}</pre>
      ) : null}
    </div>
  )
}

function NodeView({ node, depth, collapsed, onToggle, useScope, onOpenInRepo }: {
  node: TreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (key: string) => void
  useScope: boolean
  onOpenInRepo?: OpenInRepo
}) {
  // One-case subtree → hoist the whole chain into a single case row.
  const hoisted = hoistedCase(node)
  if (hoisted) {
    return <CaseRow c={hoisted.c} segs={hoisted.segs} showLocation={useScope} indent={depth} onOpenInRepo={onOpenInRepo} />
  }
  const isCollapsed = collapsed.has(node.key)
  const isDir = nodeIsDir(node)
  const copyPath = node.pathParts.join('/')
  return (
    <div>
      <button
        onClick={() => onToggle(node.key)}
        className="group flex w-full items-center gap-1.5 py-1 pr-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer min-w-0"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {/* One chevron, rotated 90° when expanded, so the twist animates. */}
        <ChevronRight className={`w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`} />
        <RowSegments segs={node.segs} isDir={isDir} expanded={!isCollapsed} />
        {copyPath && node.kind === 'path' ? <CopyButton text={copyPath} title={`Copy ${copyPath}`} /> : null}
        {onOpenInRepo && copyPath ? <RepoLinkButton onClick={() => onOpenInRepo(copyPath)} title={`Open ${copyPath} in repository`} /> : null}
        <NodeBadges counts={node.counts} />
      </button>
      {/* Animated expand/collapse: a 0fr↔1fr grid row transition slides the
          children open/closed (they stay mounted so the height can tween and the
          collapse state persists). */}
      <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${isCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
        <div className="overflow-hidden min-h-0">
          <div className="relative">
            <TreeGuide depth={depth} />
            <NodeChildren node={node} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} useScope={useScope} onOpenInRepo={onOpenInRepo} />
          </div>
        </div>
      </div>
    </div>
  )
}

function NodeChildren({ node, depth, collapsed, onToggle, useScope, onOpenInRepo }: {
  node: TreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (key: string) => void
  useScope: boolean
  onOpenInRepo?: OpenInRepo
}) {
  // Directories first (alphabetical), then this node's own cases, worst
  // status first so failures surface above passing siblings. Subtrees and
  // cases the filter fully hid don't render (their counts survive in the
  // ancestors' badges).
  const children = [...node.children.values()].filter((c) => c.visTotal > 0).sort((a, b) => a.label.localeCompare(b.label))
  const cases = [...node.visCases].sort((a, b) => statusRank(a.status) - statusRank(b.status))
  return (
    <div>
      {children.map((child) => (
        <NodeView key={child.key} node={child} depth={depth} collapsed={collapsed} onToggle={onToggle} useScope={useScope} onOpenInRepo={onOpenInRepo} />
      ))}
      {cases.map((c, i) => (
        <CaseRow key={`${caseKey(c)}-${i}`} c={c} showLocation={useScope} indent={depth} onOpenInRepo={onOpenInRepo} />
      ))}
    </div>
  )
}

export function CaseTree({ cases, visible, useScope, depth = 0, onOpenInRepo, collapsed: collapsedProp, onToggle: onToggleProp }: {
  // ALL of the runner's cases — badges tally these regardless of filters.
  cases: TestCase[]
  // The filter/search-surviving subset actually rendered as rows.
  visible: TestCase[]
  useScope: boolean
  // Base indent level, for embedding under a parent row (result sections).
  depth?: number
  // Deep-link rows to the repository browser (omitted → no link affordance).
  onOpenInRepo?: OpenInRepo
  // Collapse state can be lifted out (persisted per agent). When omitted the
  // tree keeps its own ephemeral state.
  collapsed?: Set<string>
  onToggle?: (key: string) => void
}) {
  const visibleSet = useMemo(() => new Set(visible), [visible])
  const root = useMemo(() => buildTree(cases, visibleSet, useScope), [cases, visibleSet, useScope])
  // Everything starts expanded (the filter already narrows the set); the set
  // records what the user closed. Keyed by node identity so it survives both
  // re-renders and axis switches (keys differ per axis, which is fine).
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set())
  const collapsed = collapsedProp ?? internalCollapsed
  const onToggle = onToggleProp ?? ((key: string) =>
    setInternalCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    }))
  if (visible.length === 0) return null
  return (
    <div className="flex flex-col">
      <NodeChildren node={root} depth={depth} collapsed={collapsed} onToggle={onToggle} useScope={useScope} onOpenInRepo={onOpenInRepo} />
    </div>
  )
}
