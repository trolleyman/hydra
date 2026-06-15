// Standalone harness to reproduce / verify issue #34 (text selection in the diff
// viewer being reset by a background refresh). It mounts the REAL DiffViewer with a
// mocked API so no Hydra backend / head is involved — this is a pure web-component
// test, driven from scripts/cdp-diffsel.mjs over the Chrome DevTools Protocol.
//
// Controls exposed on window for the CDP driver:
//   __selectLine(): select the text of a known diff line, returns the selected string
//   __selection():  current window.getSelection().toString()
//   __rerender():   bump unrelated parent state (forces a bare DiffViewer re-render)
//   __tick():       bump externalRefreshTrigger (the real silent-refresh code path)
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../src/stores/apiClient'
import { DiffViewer } from '../src/DiffViewer'

// ── Mock data ─────────────────────────────────────────────────────────────────
// A small, STABLE diff. Every fetch returns deep-equal content, so a refresh is a
// genuine no-op — exactly the idle-tick scenario behind #34.
function makeDiff() {
  return {
    base_ref: 'main',
    head_ref: 'HEAD',
    files: [
      {
        path: 'example/widget.ts',
        change_type: 'modified',
        additions: 2,
        deletions: 1,
        binary: false,
        hunks: [
          {
            header: '@@ -1,5 +1,6 @@',
            old_start: 1,
            new_start: 1,
            lines: [
              { type: 'context', content: 'export function widget(name: string) {', old_line_num: 1, new_line_num: 1 },
              { type: 'context', content: '  const greeting = "hello there friend"', old_line_num: 2, new_line_num: 2 },
              { type: 'deletion', content: '  return greeting + name', old_line_num: 3, new_line_num: null },
              { type: 'addition', content: '  const punctuation = "!!!"', old_line_num: null, new_line_num: 3 },
              { type: 'addition', content: '  return greeting + name + punctuation', old_line_num: null, new_line_num: 4 },
              { type: 'context', content: '}', old_line_num: 4, new_line_num: 5 },
            ],
          },
        ],
      },
    ],
  }
}

// Monkeypatch the singleton API client. `api` is a stable object, so reassigning
// its methods is enough — DiffViewer imports the same instance.
;(api as any).default = {
  ...(api as any).default,
  getAgentCommits: async () => [],
  getAgentDiff: async () => makeDiff(),
  getAgentArtifacts: async () => ({ scripts: [] }),
}

const agent: any = {
  id: 'repro-agent',
  branch_name: 'hydra/repro',
  base_branch: 'main',
  session_status: 'stopped',
  worktree_path: '/tmp/repro',
}

function Harness() {
  const [trigger, setTrigger] = useState(0)
  const [rerenders, setRerenders] = useState(0)

  ;(window as any).__tick = () => setTrigger((t) => t + 1)
  ;(window as any).__rerender = () => setRerenders((r) => r + 1)

  return (
    <div>
      <div data-testid="rerender-count" style={{ position: 'fixed', top: 0, right: 0, padding: 4, font: '12px monospace', zIndex: 9999 }}>
        r={rerenders} t={trigger}
      </div>
      <DiffViewer agent={agent} projectId="repro-project" externalRefreshTrigger={trigger} />
    </div>
  )
}

// Find the rendered code line whose text contains the needle. The line is a single
// code <span> whose children are syntax-highlight token spans (so the visible text is
// spread across several text nodes) — exactly the structure that makes a PARTIAL,
// sub-line selection fragile across re-renders (issue #34).
function findLineEl(): HTMLElement | null {
  const line = '  const greeting = "hello there friend"'
  const spans = Array.from(document.querySelectorAll('span')) as HTMLElement[]
  return spans.find((s) => s.textContent === line) ?? null
}

// Map a character offset within an element's concatenated text to (textNode, offset).
function locate(el: HTMLElement, charOffset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0
    if (charOffset <= seen + len) return { node, offset: charOffset - seen }
    seen += len
  }
  return { node: el, offset: 0 }
}

// Select a PARTIAL range *inside one line* — from the middle of one token to the
// middle of another (chars 10..28 ≈ 'eeting = "hello t'). This is the real-world
// case the user reported: a sub-line selection that must not snap to whole-line or
// collapse when the diff silently refreshes.
;(window as any).__selectLine = () => {
  const el = findLineEl()
  if (!el) return ''
  const start = locate(el, 10)
  const end = locate(el, 28)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  return sel.toString()
}
;(window as any).__selection = () => window.getSelection()?.toString() ?? ''

// Debug helpers (no nested quotes needed from the driver side).
// __tagLine stamps the live line element; __probe reports whether that same node
// is still in the DOM after a refresh — i.e. whether React recreated the line
// (which is what would drop a sub-line selection) vs. updated it in place.
;(window as any).__tagLine = () => { const el = findLineEl(); if (el) (el as any).__tag = 'T1'; return !!el }
;(window as any).__probe = () => {
  const el = findLineEl()
  const sel = window.getSelection()
  return {
    selection: sel?.toString() ?? '',
    rangeCount: sel?.rangeCount ?? 0,
    lineFound: !!el,
    lineStillTagged: el ? ((el as any).__tag ?? null) : 'noel',
  }
}

window.addEventListener('error', (e) => { (window as any).__err = String(e.error?.stack || e.message) })
try {
  createRoot(document.getElementById('root')!).render(<Harness />)
} catch (e: any) {
  ;(window as any).__err = String(e?.stack || e)
}
