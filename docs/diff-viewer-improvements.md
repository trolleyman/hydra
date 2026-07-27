# Diff viewer: improvement ideas (survey)

Status: **survey, mostly unbuilt.** Captures a researched menu of ways to improve
the agent-page diff viewer beyond plain line diffs, so the work can be picked up
later without re-deriving it. The only item here that is *built* is the indent
word-diff fix (see the top of the table). Read this before starting any of the
line items; read [docs/web-agent-page.md](web-agent-page.md) first for the render
pipeline it all plugs into.

## What the viewer already has

Grounding, because it changes the cost/benefit of everything below.

| Concern | Status |
|---|---|
| Line diff | Server-side `git diff -U<n>` in `internal/git/diff.go:190`, parsed by `parseDiff` into structured `DiffFile{hunks:[{header, old_start, new_start, lines:[{type,content,old_line_num,new_line_num}]}]}` JSON - not a patch string on the wire. |
| Intra-line diff | Hand-rolled `web/src/lib/wordDiff.ts`: **character-level** by default (a tokenization ladder drops to identifier-run / whitespace-clumped tokens only when the O(n*m) grid would exceed `MAX_CELLS=160_000`) -> trim common prefix/suffix -> `Uint32Array` LCS -> contiguous ranges -> coalesce stray confetti (<=2 char gaps) -> snap to camelCase/snake_case subword boundaries -> HTML overlay onto highlight.js output. A both-sides-mostly-changed pair (`REWRITE_FRACTION`) drops its ranges as noise. Caps `MAX_LINE_LEN=3000`. Built - see below. |
| Diff libraries | None. `web/package.json` has only `highlight.js`. No `diff`/`diff-match-patch`/`react-diff-view`/`@git-diff-view`/`shiki`/`web-tree-sitter`. |
| Ignore whitespace | Built - server flag `--ignore-space-change` (toggle in the Files settings cog). |
| Hunk collapse / expand | Built - `GapExpander`/`EdgeExpander`, `EXPAND_STEP=20`, re-fetch with larger `context`. |
| Side-by-side / unified | Built. |
| Sticky file headers | Built (`FILE_STICKY_TOP`, CSS-var coordination). |
| Big files | Built - IntersectionObserver lazy bodies + pre-measured placeholders (`diffBody.ts`/`diffMetrics.ts`), `HIDDEN_FILE_THRESHOLD=1000`. Deliberately not a virtualization lib. |
| Diff algorithm | Plain Myers (git default). `--diff-algorithm` never passed. |
| Moved-block detection | Absent. |
| Per-file "viewed" state | Absent (designed but unbuilt in [docs/diff-review-state.md](diff-review-state.md)). |
| Function-context hunk headers | Absent - `hunk.header` is stored and used only as a React key; git's `@@ ... @@ <funcname>` trailer is never rendered. |
| Whitespace-only / indent-only dimming | Absent. |

Note: git's **indent heuristic** (`--indent-heuristic`, the line-level analogue of
edit-boundary sliding that shifts a slidable added/removed block to the
lowest-penalty split) is on by default in modern git, so hunk boundaries already
benefit from it. No action needed there.

## Recommended plan, ranked by payoff / complexity

| # | Change | Complexity | Payoff | Where |
|---|---|---|---|---|
| 0a | **Indent word diff: highlight only the changed columns** | done | - | `wordDiff.ts` (built) |
| 0b | **Character-level diff + confetti coalesce + subword-boundary snap** | done | - | `wordDiff.ts` (built; char granularity so a highlight lands inside an identifier - `getUserName`->`getUserId` lights `Name`/`Id`; snapping pulls a mid-camelCase edit out to the hump so `handleClick`->`handleClose` shows `Click`/`Close` not `lick`/`lose`, while monocase `counter`->`pointer` stays the precise `cou`/`poi`) |
| 1 | `--diff-algorithm=histogram` | done | medium | `internal/git/diff.go` (built) |
| 2 | Render git's existing funcname in hunk separators | done | med-high | `diffBody.ts` `hunkContext` + `DiffViewer.tsx` `HunkContextLabel` (built; muted right-aligned label on each collapsed-gap / expander row, in both the segments and windowed-hunk render paths - same row so it adds no height) |
| 3 | Similarity-based del/add line pairing | done | **high** | `wordDiff.ts` `pairLines` + `buildWordRangeMaps` (built; order-preserving Needleman-Wunsch over the del/add block scored by token-multiset similarity, `MIN_PAIR_SIM=0.4`, `MAX_PAIR_CELLS=2500` index-pairing fallback. Note: `buildSideBySide` row layout still uses index pairing; word highlights are keyed per line number so they are correct regardless, but the side-by-side *row* pairing is a separate follow-up) |
| 4 | Whitespace-only / indent-only classification + dimming | low | med-high | new `wordDiff.ts` helper + row CSS |
| 5 | Edit-boundary sliding (token-space `cleanupSemanticLossless`) | low | medium | `wordDiff.ts` after `contiguousRanges` |
| 6 | Per-file viewed state (blob-sha keyed) | medium | high | per [docs/diff-review-state.md](diff-review-state.md) |
| 7 | Moved-block detection (zebra + allow-indentation-change) | medium | high | new `web/src/lib/movedBlocks.ts` |
| 8 | Sticky function-context header | medium | med-high | `DiffViewer.tsx` |
| 9 | Shiki token-level decorations replacing the HTML overlay | med-high | medium | `language.ts`, `wordDiff.ts` |
| 10 | AST / tree-sitter structural diff | high | low-medium | don't (see below) |

### 1. Histogram diff algorithm

`--diff-algorithm=histogram` is a one-token change at `internal/git/diff.go:190`.
Histogram is patience generalised: it anchors on the *rarest* matching line rather
than LCS-ing everything, so highly non-unique lines (`}`, blank lines) can't
mis-anchor and produce the classic "matched the wrong closing brace" garbage. It's
the best readability/speed tradeoff for brace-heavy, repeated-block code, which is
most agent-generated code. Trivial to try; easy to revert.

### 2. Render git's funcname in hunk separators (free win)

git already computes the enclosing function name and emits it after the second
`@@` (the `@@ -a,b +c,d @@ <funcname>` trailer, produced by the per-language
`xfuncname` regex). `parseHunkHeader` (`diff.go:579`) extracts only
`oldStart`/`newStart` and drops the rest; `DiffViewer.tsx` uses `hunk.header` only
as a React key. Parse the text after the second `@@` and render it in the hunk
separator / gap row. ~10 lines for a real readability gain. (Per-language drivers
need `diff=<name>` in `.gitattributes` to activate for some languages; Go/C/etc.
have built-in drivers.)

### 3. Similarity-based del/add pairing (biggest quality win)

`buildWordRangeMaps` pairs `dels[j]` with `adds[j]` by **index**. When an addition
is inserted ahead of a changed block, or the block is reordered, or the counts are
unequal (5 del / 2 add), every pair is offset and the highlighting becomes
fiction. Demonstrated failure - a 2-del / 3-add block:

| line | currently highlighted | should be |
|---|---|---|
| `- const a = 1` | `const a`, `=`, `1` | nothing (identical line exists on new side) |
| `- const b = 2` | `b`, `2` | `2` |
| `+ // new comment` | `//`, `new`, `comment` | nothing |
| `+ const b = 22` | *nothing* | `22` |

git's own `contrib/diff-highlight` has exactly this limitation; `git-delta` is the
reference for doing it right (groups `-`/`+` runs into subhunks, scores all
candidate pairings by edit distance, exposes `--max-line-distance` below which it
refuses to pair).

Sketch - order-preserving alignment (Needleman-Wunsch at line level), then the
existing token LCS only on chosen pairs:

```
pairLines(dels, adds):
  m, n = dels.length, adds.length
  if m*n > MAX_PAIR_CELLS (~2500): return index pairing   // current behaviour
  if m===1 && n===1: return [[0,0]]                        // common fast path

  sim(a, b):                     // cheap, O(len) - do NOT run the token LCS here
    if a===b: return 1
    trim common prefix/suffix chars
    return multiset-Jaccard over TOKEN_RE tokens of the trimmed middles

  GAP = 0.0; MIN_SIM = 0.45      // MIN_SIM is delta's --max-line-distance analogue
  dp[i][j] = max( dp[i-1][j-1] + (sim>=MIN_SIM ? sim : -inf),
                  dp[i-1][j] + GAP, dp[i][j-1] + GAP )
  backtrack -> matched (i,j) pairs; unmatched lines get no word ranges

  for each matched pair: computeWordDiff(dels[i].content, adds[j].content)
```

Below `MIN_SIM`, don't highlight - a bad pairing is worse than none. Multiset
Jaccard is only used to *choose* pairs; the exact LCS still produces the ranges,
so the 1:1 case is unchanged. Note `buildSideBySide` (`diffBody.ts`) uses the same
index pairing for row layout; ideally both move together, but that's riskier since
`bodyShape`/height measurement depends on the row count it produces.

### 4. Whitespace-only / indent-only classification + dimming

Cheap, composes with the existing `ignoreWhitespace` toggle rather than replacing
it. Three classes to detect and style:

- **Whitespace-only** - `old.replace(/\s+/g,'') === new.replace(/\s+/g,'')` -> dim
  the whole row, no word highlight.
- **Indent-only** - equal after `trimStart()`, differing leading whitespace -> dim,
  optionally annotate the visual-width delta (`+4`, `-2`) with tab expansion.
- **Trailing-whitespace-only** - annotate with a marker.

One clear "nothing here needs your attention" signal without hiding the change the
way `-w` does.

### 5. Edit-boundary sliding (token-space cleanupSemanticLossless)

Applies after `contiguousRanges`, before returning from `computeWordDiff`. Slide a
pure insertion/deletion run sideways while lossless (`tokens[i-1]===tokens[j-1]`
left, `tokens[i]===tokens[j]` right), scoring each reachable shift and keeping the
best. Scoring is diff-match-patch's `diff_cleanupSemanticScore_` adapted to tokens:
prefer boundaries at line edges (6), then whitespace (4/2), then punctuation (1),
worst inside an identifier (0). This makes `foo(a)` -> `foo(b, a)` highlight `b, `
rather than ` a`, and cancels the systematic bias from the fixed `>=` tie-break in
the LCS backtrack (`wordDiff.ts:128`). Token space is simpler and safer than
diff-match-patch's char space.

### 6. Per-file viewed state

Already fully designed in [docs/diff-review-state.md](diff-review-state.md) and
explicitly unbuilt. Key the viewed flag on the head-side blob sha
`(agent_id, path, blob_sha, reviewed_at)` so a file renders viewed iff its stored
sha equals the current head-side sha - auto-unticks on change, re-ticks on revert,
no invalidation logic. Follow the build order in that doc. Design note from
GitHub's version: collapse and dim viewed files but **keep the row** - fully
hiding them breaks the reviewer's directory mental model.

### 7. Moved-block detection (git --color-moved, client-side)

Reimplement git's move detection over the already-parsed `DiffLine[]` (do NOT
parse `--color-moved --color=always` ANSI - it's lossy and fights `parseDiff`). Do
it client-side in `web/src/lib/` so it spans **all files** in the response (moves
between files are the interesting case) and toggles without a refetch.

Ship `allow-indentation-change` as the default: ignore whitespace for matching,
then require a *constant* visual indent delta across the block. That's what makes
"function extracted into a new `if`, indented one level" read as one move instead
of a rewrite.

```
detectMoves(files, {allowIndentChange}):
  key(line) = allowIndentChange ? line.content.trimStart() : line.content
  skip blank/whitespace-only lines as anchors
  build addsByKey / delsByKey (LineRef = {fileIdx, lineIdx}) across ALL files,
    plus a global ordered `seq` of +/- lines so nextLine(ref) is O(1)

  // greedy block growth (git: fill_potential_moved_blocks + pmb_advance_or_null)
  for each unassigned '+' line cur:
    blocks = delsByKey.get(key(cur)).map(c => ({cursor:c,
              wsd: allowIndentChange ? visualIndent(cur)-visualIndent(c) : 0}))
    grow while blocks non-empty and cur is '+':
      cur = nextAddLine(cur)
      blocks = blocks.filter(b => {
        nxt = nextDelLine(b.cursor)
        if !nxt || key(nxt)!==key(cur): return false
        if allowIndentChange && visualIndent(cur)-visualIndent(nxt)!==b.wsd: return false
        b.cursor = nxt; return true })
    alnum = count of [0-9A-Za-z] over the block          // adjust_last_block
    if alnum < 20: discard                               // COLOR_MOVED_MIN_ALNUM_COUNT

  zebra: flip a boolean per accepted contiguous block -> two alternating tints on
    both sides, plus a link to the counterpart (fileIdx/lineIdx) for a
    "moved from path:line" chip + scroll-to.
  visualIndent(line) = tab-expanded width of leading whitespace
```

`git/diff.c` is the reference (`moved_entry`, `moved_block`,
`pmb_advance_or_null`, `adjust_last_block`, `compute_ws_delta`, `dim_moved_lines`).
~150 lines. SemanticDiff's presentation (boxes around moved blocks + centre markers
linking the two sides) is the nicer UI target if you want to invest more.

### 8. Sticky function-context header

Step 1 is item 2 (render the funcname git computed). Step 2, for a header that
updates as you scroll *within* a long hunk: run a small per-language regex (the
`xfuncname` idea, client-side) over the hunk lines, mark which declaration each
line is under, and drive a sticky bar off the IntersectionObserver machinery
`DiffViewer.tsx` already has for lazy bodies.

### 9. Shiki token-level decorations (only if the overlay bites)

`applyWordRanges` hand-parses highlight.js HTML character-by-character to avoid
straddling `<span>` boundaries - correct but brittle. Shiki's Decorations API does
range overlays at the token level natively. Cost: shiki's grammar/theme payload is
much bigger than highlight.js and you'd rewrite the `language.ts` +
`buildHighlightMaps`/`syncHighlight`/`asyncHighlight` path. Only worth it if the
HTML overlay produces real bugs.

## What to skip

- **Full AST / tree-sitter structural diff (item 10).** difftastic (tree-sitter
  CST -> uniform s-expression tree -> Dijkstra shortest path over
  (posA, posB) vertices) and GumTree (top-down hash matching + bottom-up
  >=50%-common-descendants matching, with an explicit *move* op) are the reference
  approaches, but: difftastic is a CLI with no browser build and there is **no
  reusable browser tree-diff**; `web-tree-sitter` grammars are heavy (TypeScript
  2.34 MB, tsx 2.41 MB, cpp 4.66 MB, Go 236 kB, each lazily fetched) on top of the
  wasm runtime; and the payoff is mostly *reformatting immunity*, which barely
  applies to Hydra's diffs (real semantic agent edits, not formatter churn).
  `--ignore-all-space` + item 4 covers the reformatting case for ~0.1% of the cost.
  GitHub itself has shipped no native semantic/syntax-aware diff. Revisit only if
  agents start running formatters that churn whole files. The one narrow
  tree-sitter play worth considering later is using it *purely* to extract
  declaration ranges (a query, not a tree diff) for item 8 - but regexes get most
  of that benefit with zero wasm.

  Even the reference implementation caps out and falls back to line+word diff,
  which is exactly what this repo already does. difftastic's own defaults:
  `DEFAULT_GRAPH_LIMIT` = 3,000,000 vertices, `DEFAULT_BYTE_LIMIT` = 1,000,000
  bytes (files over ~1 MB are never structurally diffed), `DEFAULT_PARSE_ERROR_LIMIT`
  = 0 (any parse error -> text fallback); it ships 44 syntaxes and its fallback is
  "line-oriented diffing with word-level highlighting". The blow-up is structural:
  a vertex is a *triple* (left pos, right pos, parents-to-exit-together) - the
  third component tracks nesting - so the graph is O(L*R) in s-expression item
  counts but O(2^N) in the deepest list-nesting depth N, which is why the graph
  limit and lazy graph construction exist. Deeply-nested code is its worst case.
- **Migrating to `react-diff-view` or `@git-diff-view/react`.** Both are good and
  feature-complete, but adopting either would discard the measured-placeholder
  lazy-mount architecture that [docs/web-agent-page.md](web-agent-page.md)
  documents as the deliberate fix for the growing-document scroll bug, plus
  per-agent view state, the toolbar, and the tests/preview/artifacts panels.
  Borrow ideas (`react-diff-view`'s `pickRanges` + `renderToken`, its
  `markEdits(type:'block')`, `@git-diff-view/core`'s worker-offload pattern), not
  the component.

## Reference sources

- git options: <https://raw.githubusercontent.com/git/git/master/Documentation/diff-options.adoc>
- git move detection impl: <https://github.com/git/git/blob/master/diff.c>
- indent heuristic: <https://github.com/mhagger/diff-slider-tools>
- xfuncname / diff drivers: <https://tekin.co.uk/2020/10/better-git-diff-output-for-ruby-python-elixir-and-more>
- delta architecture (homologous-pair inference): <https://github.com/dandavison/delta/blob/main/ARCHITECTURE.md>
- diff-match-patch cleanupSemanticLossless: <https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js>
- Myers O(ND): <https://publications.mpi-cbg.de/Myers_1986_6330.pdf>
- patience: <https://blog.jcoglan.com/2017/09/19/the-patience-diff-algorithm/> - histogram: <https://www.raygard.net/2025/01/28/how-histogram-diff-works/>
- difftastic: <https://github.com/Wilfred/difftastic/wiki/Structural-Diffs> - GumTree refactoring-aware: <https://arxiv.org/pdf/2403.05939>
- SemanticDiff PR viewer: <https://semanticdiff.com/blog/pr-viewer/>
- tree-sitter wasm grammar sizes: <https://app.unpkg.com/tree-sitter-wasms@latest/files/out>
- react-diff-view: <https://github.com/otakustay/react-diff-view> - @git-diff-view: <https://github.com/MrWangJustToDo/git-diff-view> - shiki decorations: <https://shiki.style/packages/transformers>
