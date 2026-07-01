# Agent tests — design plan: path tree + stdout streaming

Living design doc (draft, uncommitted). Captures two follow-on features for the
agent-tests panel, plus the shared data-model change they both depend on.

Already shipped (branch `hydra/any-way-we-could-surface-eg-eslint`): a first-class
non-failing **warning** outcome (`CaseWarning` + `Report.Warnings`), a short/long
verdict chip (sidebar = passed only; header/panel = `✓ N ⚠ M ▸| K`), and amber
warning rows in the panel. Everything below builds on that.

---

## Shared foundation: structured location on `TestCase`

Both features want to know **where** a case lives, not just its display name. Today
`junitCaseToTestCase` joins `classname › name` into one string and discards the split.
Replace that with a structured location.

```go
type TestCase struct {
    Name    string     `json:"name"`              // leaf name only (test func / "describe > it")
    Status  CaseStatus `json:"status"`
    Path    string     `json:"path,omitempty"`    // repo-relative: dir/dir/file.ts (or Go package dir)
    Line    int        `json:"line,omitempty"`    // optional 1-based location...
    Col     int        `json:"col,omitempty"`
    EndLine int        `json:"end_line,omitempty"`
    EndCol  int        `json:"end_col,omitempty"`
    DurationMs int64   `json:"duration_ms"`
    Message string     `json:"message,omitempty"`
}
```

**Where `Path` comes from per runner:**
- **Go (gotestsum JUnit):** `classname` is the *package import path*
  (`github.com/trolleyman/hydra/internal/artifacts`). Strip the module prefix →
  `internal/artifacts`. This is a **package dir**, not a file (a package spans files;
  gotestsum/`go test -json` don't expose the file). So Go bottoms out at the package
  dir; test funcs are the leaves under it. No line/col for Go.
- **Web (vitest JUnit):** `classname` is the real file (`src/api/format_error.test.ts`);
  `name` is the `describe > it` chain. Line/col only on failures (from vitest's JSON
  reporter), otherwise absent.
- **eslint / lint tools:** file + line + col are first-class (eslint JSON has
  `filePath`, `line`, `column`, `endLine`, `endColumn`) → populate all of them.

**Why line/col now (even though unused):** they let a failing/warning case deep-link
into the **diff viewer and highlight the exact range** later. Adding the fields now
avoids a second model/API migration.

**Backward compatibility:** if `Path` is empty (old cached reports, or a runner that
doesn't set it), the tree falls back to a flat list, or splits `Name` on `›`. The
parser should set `Path = classname`, `Name = bare test name` (stop pre-joining).

Touch points: `internal/tests/types.go`, `parse.go` (JUnit + Hydra-JSON),
`api/openapi.yaml` `TestCase` (+ regen Go/TS), `web/.../TestsPanel.tsx`.

---

## Feature 1 — Filters + path tree (symmetry with the artifacts diff)

### The framing: tests filter like artifacts diff
The artifacts panel hides **unchanged** artifacts by default and offers a filter bar to
reveal them. Tests should work identically — hide **passing** by default (the boring,
expected state), show the interesting ones, filter to reveal the rest. The mapping is
near-exact, so we reuse the artifacts machinery rather than invent a parallel one:

| Artifacts | Tests |
|---|---|
| `change_type`: added / removed / modified / **unchanged** | `status`: failed / warning / skipped / **passed** |
| `DEFAULT_HIDDEN_CHANGE_TYPES = ['unchanged']` | `DEFAULT_HIDDEN_STATUSES = ['passed']` |
| `computeVisibleFiles(files, filter, search)` | `computeVisibleCases(cases, filter, search)` |
| `ArtifactFilterBar` → `TagScopeFilter` "changes" scope | filter bar → `TagScopeFilter` "status" scope |
| search box + reset + `% changed` threshold | search box + reset (no threshold) |

This also replaces today's ad-hoc show/hide (a lone `showPassing` roll-up; skipped as a
flat count) with one coherent, familiar model — and expandable skipped falls out for
free (it's just another status the filter shows).

### The filter bar (mirror `ArtifactFilterBar`)
A right-floated cluster (`ml-auto flex flex-wrap items-center gap-2`) in the sticky
"Tests" header — the panel has no right cluster today, clean slate:
- **Search box** — `h-7 w-36`, Search icon + X clear; reuse `searchFiles`/`fuzzyScore`
  from `artifactFilter.ts`, matching case `path` + `name`.
- **Reset button** — shown only when non-default (`RotateCcw` + "reset").
- **One `TagScopeFilter` "status" dropdown** — checkboxes for failed / warning /
  skipped / passed, with per-value counts and shift-click-to-isolate (all free from the
  generic component). `defaultOff = ['passed']`.
- **Persistence** — a `testFilterPrefs.ts` cloned from `artifactPrefs.ts`: the same
  inverted "record only what's OFF" model, seeded to hide `passed`, keyed per
  project+agent, `load/save/isDefault` mirrors. Search stays ephemeral (not persisted),
  as in artifacts.
- Open decision: default-hide `skipped` too, or only `passed`? (Artifacts hides only
  `unchanged`.) Leaning **only `passed`** — skipped is worth a glance.

### The view mode: "Group by result" in the changes cog
The cog (`SettingsPopup` in `DiffViewer.tsx`) already has a `Tree / Flat / Grouped-by-folder`
radio for the file list — exact precedent. Add a **"Test results"** radio, persisted in
`AgentViewPrefs` as `testGroupBy?: 'path' | 'result'` (sits beside `collapsedFiles`):
- **By path** *(default)* — one unified path tree of the filtered cases; each file/dir
  node shows mixed status badges (`✓142 ⚠4 ✗2`).
- **By result** — separate collapsible sections per status (Failing / Warnings /
  Skipped / Passing), each rendering its own path tree. (≈ today's sections, but
  filter-driven and tree-rendered.)

The filter bar applies in **both** modes (just like artifacts filters apply regardless
of the file-list view mode).

### The path tree (shared `CaseTree` component)
Renders whatever the filter lets through, in either mode. Built from each case's `Path`
(from the shared foundation), split on `/` into a trie:
1. **Common-prefix trim** — strip the shared module/repo prefix (`github.com/trolleyman/hydra/`
   → repo-relative). Prefer backend-relative paths; else longest-common-prefix in UI.
2. **Compact single-child chains** (the "deeply/nested/empty" ask) — a dir whose only
   child is a dir merges to one row (`internal/artifacts`, not `internal` → `artifacts`).
   Recursive; same idea as the sidebar's nested-folder compaction / VS Code compact folders.
3. **Single-item hoist** (the "1 warning in a file → show on the parent" ask) — a subtree
   with exactly one case collapses the whole chain to one row
   (`internal/heads/cow.go › TestOverlayMount ⚠`), so a lone warning isn't five expanders deep.
4. **Copiable paths** — each dir/file header click-to-copies its repo-relative path; a
   case copies `path:line`.
- Leaf rows reuse the existing `FailingCase`/`WarningCase` message boxes for
  failing/warnings; plain rows for passing/skipped.

### Reuse (all exist today)
- `web/src/lib/artifactFilter.ts` — `computeVisibleFiles`, `fileMatchesFilter`,
  `searchFiles`/`fuzzyScore`, `computeScopeCounts`, inverted filter model → template for
  `computeVisibleCases`.
- `web/src/lib/artifactPrefs.ts` — `ArtifactTagFilter`, `defaultTagFilter`,
  `load/saveTagFilter`, `isDefaultTagFilter` → template for `testFilterPrefs.ts`.
- `web/src/components/ArtifactFilterBar.tsx` — `TagScopeFilter` (generic
  dropdown+checkboxes+counts+isolate) reused directly for the status scope.
- `web/src/components/ArtifactImageDiff.tsx` — `SegmentedToggle` (if a segmented control
  fits better than a cog radio anywhere).
- `SettingsPopup` `FileView` radio (`DiffViewer.tsx`) + `AgentViewPrefs`
  (`agentViewPrefs.ts`) → precedent + store for the `testGroupBy` view mode.
- `useMeasuredHeight` (`CollapsibleCard`) — already used by both panels to dock card
  headers under a wrapping sticky bar; handles a two-row filter bar.

### Effort: ~1.5 days
The filter bar + persistence is cheap (largely a `TagScopeFilter` + a cloned prefs
module). The `CaseTree` with compaction + single-hoist is the bulk; the cog view mode +
`testGroupBy` pref is small. Shared `Path` field (foundation) unblocks it.

---

## Feature 2 — `stdout` test type + `::hydra:test:*::` streaming

### Problem
A `junit` runner writes a report file parsed only *after* the process exits, so counts
appear all-at-once. We want a run to stream `✓ 123 / 4556` live into the panel and the
sidebar. This extends the existing `::hydra:progress::` mechanism (same line-scanner,
same Event→WS→panel fan-out).

### Config surface (`config.TestScript`)
New **`type`** field (toml `type`):
- **`junit`** *(default)* — current behaviour: parse `*.xml`/`*.json` from
  `$HYDRA_TEST_OUTPUT`; exit-code fallback.
- **`stdout`** — parse `::hydra:test:*::` markers live from stdout; the accumulated
  cases *are* the report (no file needed).

Add to openapi `TestScript`, the TS model, and Settings `TestsEditor.tsx` (dropdown).
Helper `IsStreaming()`.

### Protocol (stdout lines)
```
::hydra:test:total:: 4556                          # optional — enables the N/total denominator
::hydra:test:pass:: internal/artifacts › TestGenerateAndCache
::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement
::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected kid-2 to be kid-3
::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon
::hydra:test:done::                                # optional explicit settle; else process-exit settles
```
- The token before `›` is the **path** (optionally `path:line:col`), after it the leaf
  **name**, after `|` the message. This reuses Feature 1's `Path`/line/col so streamed
  runs get the tree + future diff-highlight for free.
- `warn` maps to the shipped `CaseWarning` bucket — zero model change.

### Backend (`internal/tests`)
1. `scan()` gains a `::hydra:test:` branch beside the `ProgressMarker` branch → parse
   into a `TestCase` (path, line/col, status, name, message).
2. **In-flight accumulation:** hold `m.cases[dir] []TestCase` + a running tally next to
   `m.logs`/`m.progress`; a late subscriber gets the current partial via the snapshot.
3. **New coalesced Event `counts`** (running totals + newly-appended cases), flushed
   ~10×/sec or every K cases. *Main perf guard* — a 4,556-test run must not emit 4,556
   WS frames.
4. **Settle:** `type=stdout` → accumulated cases become the Report (status from tally:
   any `fail` → failing). `type=junit` → `ParseDir` as today. Persisted `report.json`
   and caching unchanged either way.

### API + WS
- New WS message `counts` (name + running totals + appended cases). Mirror in
  `tests_ws.go` struct and the TS `TestsWSMessage` union; `TestsPanel` merges it live
  (rendering already re-renders from `TestRunResult`; the `CaseTree` grows in place).

### Live counts in the sidebar/header ("even in the sidebar — slick")
- **Nuance:** the chips read `agent.tests` (`TestSummary`) from the **agent-list
  stream**, a *different* path than the tests WS.
- **Cheap win:** route the runner's running `progress` string (`123/4556`) into the
  agent-list SSE — the chip already renders `progress` when `running`, so `✓ 123/4556`
  in the sidebar is nearly free.
- **Full per-status live chip** (`✓123 ⚠2 ✗1` ticking): needs the summary
  recomputed+streamed per head — a later, larger step.

### Effort: ~2 days
`type` field + marker parser + in-flight accumulation + `counts` WS + panel merge
(~1d); sidebar `123/4556` via progress routing (~0.5d); coalescing/backpressure +
tests + a reference emitter (bash/jest/eslint wrapper that prints the markers) + docs
(~0.5d).

---

## Suggested sequencing
1. **Shared model** — add `Path` + line/col to `TestCase`, populate from JUnit
   classname (strip Go module prefix) and Hydra-JSON. Small; unblocks both features.
2. **Filter bar** — the artifacts-symmetry filter (status scope, passing hidden by
   default, search) reusing `TagScopeFilter` + a cloned `testFilterPrefs`. Shippable on
   its own, before the tree even exists (filters the current flat lists). ~0.5d.
3. **Feature 1 (path tree + view mode)** — `CaseTree` + the `by path | by result` cog
   setting. Biggest visible win. ~1–1.5d.
4. **Feature 2 (stdout streaming)** — the `type` field + markers + live counts, reusing
   the tree + filter for the live-growing list. ~2d.

Open decisions still to confirm:
- Default-hidden statuses: only `passed`, or `passed` + `skipped`? (recommend only `passed`)
- Default view mode: `by path` unified vs `by result` sections (recommend `by path`).
- `by path` node badges: mixed per-file (`✓142 ⚠4 ✗2`) vs single dominant status.
- Streaming marker denominator: explicit `total` marker vs derived from seen cases.
