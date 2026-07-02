# Agent tests — design plan: path tree + stdout streaming

Living design doc. Captures two follow-on features for the agent-tests panel,
plus the shared data-model change they both depend on. **Status: implemented on
this branch** — the shared foundation (structured `Path`/`Scope`/line-col),
Feature 1 (filter bar + `CaseTree` + the two cog checkboxes), and Feature 2
(`type = "stdout"` + `::hydra:test:*::` streaming + coalesced counts + the live
per-status sidebar chip for streamed runs). Tier-2 dotted-classname→file probing
remains future work — Maven Surefire / Gradle JUnit XML genuinely carries no
file attribute, only `classname`, so the filesystem probe is the only route to
a `Path` for Java-style reports.

Already shipped (branch `hydra/any-way-we-could-surface-eg-eslint`): a first-class
non-failing **warning** outcome (`CaseWarning` + `Report.Warnings`), a short/long
verdict chip (sidebar = passed only; header/panel = `✓ N ⚠ M ▸| K`), and amber
warning rows in the panel. Everything below builds on that.

---

## Shared foundation: structured location on `TestCase`

Both features want to know **where** a case lives, not just its display name. Today
`junitCaseToTestCase` joins `classname › name` into one string and discards the split.
Replace that with a structured location, split into two axes:

- **`Path`** — a *filesystem* location (repo-relative file or dir). Copyable,
  deep-linkable into the diff viewer, may carry line/col.
- **`Scope`** — a *logical* nesting chain between the path and the leaf name: a Java
  class chain, a pytest class, a vitest `describe` chain, a Go subtest parent. Stored
  as a JSON array (no separator ambiguity, no re-parsing; file names contain dots, so
  a single separator-polymorphic string can't work).

```go
type TestCase struct {
    Name    string     `json:"name"`              // leaf name only (test func / "it")
    Status  CaseStatus `json:"status"`
    Path    string     `json:"path,omitempty"`    // repo-relative: dir/dir/file.ts (or Go package dir)
    Scope   []string   `json:"scope,omitempty"`   // logical nesting: class chain / describe chain
    Line    int        `json:"line,omitempty"`    // optional 1-based location...
    Col     int        `json:"col,omitempty"`
    EndLine int        `json:"end_line,omitempty"`
    EndCol  int        `json:"end_col,omitempty"`
    DurationMs int64   `json:"duration_ms"`
    Message string     `json:"message,omitempty"`
}
```

**One shared classifier** routes a JUnit `classname` (and later a streamed marker
location token) to the right axis:
- contains `/` or ends in a known file extension → **file/dir** → `Path`
  (vitest `src/api/format_error.test.ts`, eslint files, Go package dirs after
  module-prefix strip);
- dotted with no slash (`com.example.FooTest`, `tests.test_module.TestClass`) →
  **class chain** → `Scope = split(".")`. This is what Java/Kotlin/pytest/C# JUnit
  emitters produce — today those render as one opaque flat string.

**Where `Path`/`Scope` come from per runner:**
- **Go (gotestsum JUnit):** `classname` is the *package import path*
  (`github.com/trolleyman/hydra/internal/artifacts`). Strip the module prefix (read
  from the checkout's `go.mod`) → `internal/artifacts`. This is a **package dir**, not
  a file (a package spans files; gotestsum/`go test -json` don't expose the file). So
  Go bottoms out at the package dir; test funcs are the leaves under it. Subtests
  (`TestFoo/sub`) become `Scope=["TestFoo"], Name="sub"`. No line/col for Go.
- **Web (vitest JUnit):** `classname` is the real file (`src/api/format_error.test.ts`)
  → `Path`; `name` is the `describe > it` chain → `Scope = describes`, `Name = it`.
  Line/col only on failures (from vitest's JSON reporter), otherwise absent.
- **eslint / lint tools:** file + line + col are first-class (eslint JSON has
  `filePath`, `line`, `column`, `endLine`, `endColumn`) → populate all of them.
- **Java/pytest-style (dotted classname):** `Scope` from the dots; `Path` via the
  three-tier mapping below.

**Dotted classname → `Path` mapping (three tiers):**
1. **JUnit `file`/`line` attributes — free and exact.** pytest's junitxml natively
   emits `file="tests/test_mod.py" line="12"` on every `<testcase>` (0-based line);
   jest-junit has `addFileAttribute`. Read these first — no heuristics, and pytest
   gets `Line` populated for free. *(Foundation step.)*
2. **Filesystem probing** for Java/Kotlin/C#: the parser runs host-side with the
   checkout dir in hand, so it can *check* — strip a trailing `$Nested` suffix, stat
   conventional roots (`src/test/java/com/example/FooTest.java`, `.kt`), else one
   bounded glob `**/com/example/FooTest.*`, caching the discovered source root per
   report. *(Deferrable; ship after the foundation.)*
3. **Fallback** — no `file` attr, no probe hit → `Path` empty, scope-only; the tree's
   per-case axis fallback (see `segmentsFor`, Feature 1) keeps every view coherent.

**Why line/col now (even though unused):** they let a failing/warning case deep-link
into the **diff viewer and highlight the exact range** later. Adding the fields now
avoids a second model/API migration.

**Backward compatibility:** if `Path` and `Scope` are both empty (old cached reports,
or a runner that doesn't set them), the tree falls back to a flat list, or splits
`Name` on `›`. The parser should classify `classname` into `Path`/`Scope` and keep
`Name = bare test name` (stop pre-joining).

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
free. **Skipped is treated exactly like every other status** (confirmed with user):
it filters via the status scope, renders as expandable rows in the tree (with the
skip reason shown dimmed, like a failure message), and gets its own collapsible
section in the by-result view — never a mute count-only roll-up.

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

### The view mode: two orthogonal checkboxes in the changes cog
The cog (`SettingsPopup` in `DiffViewer.tsx`) already has a `Tree / Flat / Grouped-by-folder`
radio for the file list — exact precedent. Add a **"Test results"** group of two
*checkboxes* (they compose; a radio would force fake exclusivity), persisted in
`AgentViewPrefs` as `testGroupResult?: boolean` + `testUseScope?: boolean` (beside
`collapsedFiles`):
- **☐ Group by result** *(off by default)* — off: one unified tree of the filtered
  cases; on: separate collapsible sections per status (Failing / Warnings / Skipped /
  Passing), each rendering its own tree. (≈ today's sections, but filter-driven and
  tree-rendered.)
- **☐ Group by scope** *(off by default)* — off: path segments then scope segments
  (`dir/file › describe › it`); on: scope segments only (`com › example › FooTest`),
  with `file:line` as a dim secondary affordance on leaves so the diff deep-link
  survives the switch. **Disabled** (greyed, not hidden) when no loaded case has any
  `Scope` — the axis simply doesn't exist for e.g. a pure-eslint report.

Which axis a case contributes is a pure render-time derivation — one function, with
per-case fallback so a missing axis never breaks a view:

```ts
function segmentsFor(c: TestCase, useScope: boolean): string[] {
  if (useScope) return c.scope?.length ? c.scope : splitPath(c.path)
  return [...splitPath(c.path), ...(c.scope ?? [])]
}
```

Case identity (expansion state, dedup) stays keyed on `path + scope + name` regardless
of view. The filter bar applies in **all** combinations (just like artifacts filters
apply regardless of the file-list view mode).

### The path tree (shared `CaseTree` component)
Renders whatever the filter lets through, in any mode. Built from each case's
`segmentsFor` list into a trie:
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
  (`agentViewPrefs.ts`) → precedent + store for the `testGroupResult`/`testUseScope`
  checkboxes.
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
- The token before `›` is the **location** (optionally `:line:col`-suffixed), routed
  through the shared foundation's classifier — file-like → `Path`, dotted →
  `Scope` — so `::hydra:test:pass:: com.example.FooTest › testBar` works too, and
  streamed runs get the tree + future diff-highlight for free. Intermediate `›`
  tokens (`file › describe › it`) append to `Scope`.
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
- **Full per-status live chip** (`✓123 ⚠2 ✗1` ticking) — **implemented** for
  `type=stdout`: the running Report snapshot carries the streamed tallies (so the
  summary Peek sees them), the manager fires a throttled (2s) `onProgress` →
  `agents_changed` nudge from the counts flush, and the chip renders live ✓/✗/⚠
  segments while running (short form: tallies only; long form adds skipped + the
  `N/total` progress). junit runs still show only the progress string mid-run —
  they report nothing per-case until settle.

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
3. **Feature 1 (path tree + view modes)** — `CaseTree` (segment-driven via
   `segmentsFor`) + the two cog checkboxes. Biggest visible win. ~1–1.5d.
4. **Feature 2 (stdout streaming)** — the `type` field + markers + live counts, reusing
   the tree + filter for the live-growing list. ~2d.

Decided (this thread):
- View modes are two orthogonal checkboxes (`Group by result`, `Group by scope`), both
  off by default; `Group by scope` disables when no case carries a `Scope`.
- Structured location is two axes: `Path` (filesystem, copyable/deep-linkable) +
  `Scope []string` (logical chain); a shared classifier routes JUnit classnames and
  streamed marker tokens. Dotted classnames map to `Path` via file attr → fs probe →
  empty (tiers 1/3 in foundation, tier 2 deferrable).

Open decisions still to confirm:
- Default-hidden statuses: only `passed`, or `passed` + `skipped`? (recommend only `passed`)
- Tree node badges: mixed per-file (`✓142 ⚠4 ✗2`) vs single dominant status.
- Streaming marker denominator: explicit `total` marker vs derived from seen cases.
