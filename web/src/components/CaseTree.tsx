import { useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, SkipForward, X } from 'lucide-react'
import type { TestCase } from '../api/models/TestCase'
import { caseKey, caseLocation, splitPath } from '../lib/testCases'

// CaseTree renders test cases as a collapsible location tree (TESTS_PLAN.md
// Feature 1), built from each case's structured location:
//   - by path (default): dir/dir/file segments, then the scope chain
//     (describe/class levels) inside the file;
//   - by scope (useScope): the class chain alone, with file:line shown as a
//     dim secondary affordance on the leaf.
// Two densification rules keep it shallow: a chain of single-child folders
// merges into one row (internal/artifacts — like VS Code compact folders), and
// a subtree holding exactly ONE case collapses the whole chain into that
// case's row, prefixed with the chain (so a lone warning isn't five expanders
// deep). Dir/file rows carry a hover copy button (repo-relative path); case
// rows copy path:line. Cases with no location (old cached reports, exit-code
// fallbacks) land at the root as flat rows.

type SegKind = 'path' | 'scope'
type Seg = { label: string; kind: SegKind }

function caseSegs(c: TestCase, useScope: boolean): Seg[] {
  const path: Seg[] = splitPath(c.path).map((label) => ({ label, kind: 'path' as const }))
  const scope: Seg[] = (c.scope ?? []).map((label) => ({ label, kind: 'scope' as const }))
  if (useScope) return scope.length > 0 ? scope : path
  return [...path, ...scope]
}

type TreeNode = {
  label: string // display label; single-child chains merge into it
  kind: SegKind
  // Real path segments accumulated from the root through this node (path-kind
  // segments only) — the copyable repo-relative path.
  pathParts: string[]
  key: string // stable identity for the collapse set
  children: Map<string, TreeNode>
  cases: TestCase[] // cases attached directly at this node
  counts: Record<string, number>
  total: number
}

function newNode(label: string, kind: SegKind, pathParts: string[], key: string): TreeNode {
  return { label, kind, pathParts, key, children: new Map(), cases: [], counts: {}, total: 0 }
}

function buildTree(cases: TestCase[], useScope: boolean): TreeNode {
  const root = newNode('', 'path', [], '')
  for (const c of cases) {
    let node = root
    node.total++
    node.counts[c.status] = (node.counts[c.status] ?? 0) + 1
    for (const seg of caseSegs(c, useScope)) {
      const childKey = `${node.key}/${seg.label}`
      let child = node.children.get(childKey)
      if (!child) {
        child = newNode(seg.label, seg.kind, seg.kind === 'path' ? [...node.pathParts, seg.label] : node.pathParts, childKey)
        node.children.set(childKey, child)
      }
      node = child
      node.total++
      node.counts[c.status] = (node.counts[c.status] ?? 0) + 1
    }
    node.cases.push(c)
  }
  compact(root)
  return root
}

// compact merges every childless-of-cases single-child chain into one row:
// internal → artifacts becomes "internal/artifacts" (path segments join with
// "/", scope levels with "›"). The merged node keeps the DEEPEST child's key,
// so its collapse state survives re-renders that change the chain above it.
function compact(node: TreeNode): void {
  for (let child of [...node.children.values()]) {
    node.children.delete(child.key)
    while (child.cases.length === 0 && child.children.size === 1) {
      const only = [...child.children.values()][0]
      only.label = `${child.label}${only.kind === 'path' ? '/' : ' › '}${only.label}`
      child = only
    }
    compact(child)
    node.children.set(child.key, child)
  }
}

// hoistedCase returns the single case of a one-case subtree along with the
// chain prefix leading to it, or null when the subtree holds more than one.
function hoistedCase(node: TreeNode): { c: TestCase; prefix: string } | null {
  if (node.total !== 1) return null
  let prefix = node.label
  let cur = node
  while (cur.cases.length === 0) {
    const next: TreeNode | undefined = [...cur.children.values()][0]
    if (!next) return null
    // Path segments chain with "/", a scope level after the path with "›".
    prefix += (next.kind === 'path' ? '/' : ' › ') + next.label
    cur = next
  }
  return { c: cur.cases[0], prefix }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

const STATUS_RENDER_ORDER = ['failed', 'warning', 'passed', 'skipped']

function statusRank(s: string): number {
  const i = STATUS_RENDER_ORDER.indexOf(s)
  return i === -1 ? STATUS_RENDER_ORDER.length : i
}

// NodeBadges shows a node's mixed per-status tallies (✓142 ⚠4 ✗2), omitting
// zero buckets.
function NodeBadges({ counts }: { counts: Record<string, number> }) {
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

// CaseRow renders one test case: glyph + name (optionally chain-prefixed for a
// hoisted case), the message box for failing/warning cases, duration, a copy
// affordance, and — in scope mode — the file:line secondary so the diff
// deep-link survives the axis switch.
export function CaseRow({ c, prefix, showLocation, indent = 0 }: {
  c: TestCase
  // The compacted chain leading here when this row was hoisted out of a
  // one-case subtree (rendered dim before the leaf name).
  prefix?: string
  // Show the case's path:line inline (scope-mode leaves, flat lists).
  showLocation?: boolean
  indent?: number
}) {
  const failedish = c.status === 'failed' || c.status === 'warning'
  const loc = caseLocation(c)
  const copyable = loc || (prefix ? `${prefix} › ${c.name}` : c.name)
  const boxTone = c.status === 'failed'
    ? 'bg-red-50/40 dark:bg-red-900/10'
    : c.status === 'warning' ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''
  const msgTone = c.status === 'failed'
    ? 'text-red-700 dark:text-red-300 bg-red-100/50 dark:bg-red-900/20 border-red-200/60 dark:border-red-900/40'
    : 'text-amber-700 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-900/20 border-amber-200/60 dark:border-amber-900/40'

  return (
    <div className={`group flex flex-col gap-1.5 py-1.5 pr-3 ${boxTone}`} style={{ paddingLeft: `${indent * 14 + 12}px` }}>
      <div className="flex items-center gap-2 min-w-0">
        <StatusGlyph status={c.status} />
        <span className={`font-mono text-xs min-w-0 truncate ${failedish ? 'font-medium' : 'text-gray-600 dark:text-gray-400'}`}>
          {prefix ? <span className="text-gray-400 dark:text-gray-500">{prefix} › </span> : null}
          {c.name}
        </span>
        {showLocation && loc ? (
          <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500 truncate shrink-1">{loc}</span>
        ) : null}
        <CopyButton text={copyable} title={loc ? `Copy ${loc}` : 'Copy test name'} />
        {c.duration_ms != null && c.duration_ms > 0 ? (
          <span className="ml-auto font-mono text-[10px] text-gray-400 shrink-0">{c.duration_ms}ms</span>
        ) : null}
      </div>
      {failedish && c.message ? (
        <pre className={`ml-5 text-[11px] font-mono whitespace-pre-wrap border rounded px-2.5 py-1.5 ${msgTone}`}>{c.message}</pre>
      ) : null}
    </div>
  )
}

function NodeView({ node, depth, collapsed, onToggle, useScope }: {
  node: TreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (key: string) => void
  useScope: boolean
}) {
  // One-case subtree → hoist the whole chain into a single case row.
  const hoisted = hoistedCase(node)
  if (hoisted) {
    return <CaseRow c={hoisted.c} prefix={hoisted.prefix} showLocation={useScope} indent={depth} />
  }
  const isCollapsed = collapsed.has(node.key)
  const copyPath = node.pathParts.join('/')
  return (
    <div>
      <button
        onClick={() => onToggle(node.key)}
        className="group flex w-full items-center gap-1.5 py-1 pr-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer min-w-0"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {isCollapsed ? <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" /> : <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />}
        <span className={`text-xs font-mono truncate min-w-0 ${node.kind === 'path' ? 'text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-400 italic'}`}>
          {node.label}
        </span>
        {copyPath && node.kind === 'path' ? <CopyButton text={copyPath} title={`Copy ${copyPath}`} /> : null}
        <NodeBadges counts={node.counts} />
      </button>
      {!isCollapsed && <NodeChildren node={node} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} useScope={useScope} />}
    </div>
  )
}

function NodeChildren({ node, depth, collapsed, onToggle, useScope }: {
  node: TreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (key: string) => void
  useScope: boolean
}) {
  // Directories first (alphabetical), then this node's own cases, worst
  // status first so failures surface above passing siblings.
  const children = [...node.children.values()].sort((a, b) => a.label.localeCompare(b.label))
  const cases = [...node.cases].sort((a, b) => statusRank(a.status) - statusRank(b.status))
  return (
    <div>
      {children.map((child) => (
        <NodeView key={child.key} node={child} depth={depth} collapsed={collapsed} onToggle={onToggle} useScope={useScope} />
      ))}
      {cases.map((c, i) => (
        <CaseRow key={`${caseKey(c)}-${i}`} c={c} showLocation={useScope} indent={depth} />
      ))}
    </div>
  )
}

export function CaseTree({ cases, useScope }: { cases: TestCase[]; useScope: boolean }) {
  const root = useMemo(() => buildTree(cases, useScope), [cases, useScope])
  // Everything starts expanded (the filter already narrows the set); the set
  // records what the user closed. Keyed by node identity so it survives both
  // re-renders and axis switches (keys differ per axis, which is fine).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const onToggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  if (cases.length === 0) return null
  return (
    <div className="flex flex-col">
      <NodeChildren node={root} depth={0} collapsed={collapsed} onToggle={onToggle} useScope={useScope} />
    </div>
  )
}
