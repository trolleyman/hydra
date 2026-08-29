# Testing internals - the agent test gate

Run the Go suite with standard tooling: `go test ./...`.

This doc covers how Hydra ingests and renders a project's `[tests.<name>]` runner
output. You only need it when touching `internal/tests`, the tests panel
(`web/src`), or a project's test-runner config.

Each runner may set `auto_run = "always"` (the default), `"settled"` (do not
start a missing run while the agent is actively working), or `"never"` (only the
Tests card's Refresh action starts it). Cached verdicts remain visible in every
mode, and Refresh always runs immediately.

## Agent test gate - warnings

A project's `[tests.<name>]` runners write a JUnit-XML or Hydra-native-JSON report into
`$HYDRA_TEST_OUTPUT`, which Hydra parses into passed/failed/skipped **and warnings**
counts (`internal/tests`). A *warning* is a non-failing diagnostic (an eslint warning,
a deprecation, a lint nit): it is surfaced but **never** flips the verdict to failing or
gates the merge. The verdict chip shows warnings only in its *long* form (agent header /
tests panel) as an amber `⚠ N`; the *short* sidebar chip stays `✓ N` (passed only).

Two ways to feed warnings in:

- **eslint's JUnit formatter** — warning-severity messages are emitted as
  `<failure type="warning">`, which Hydra maps to a warning (errors stay failures):
  ```bash
  eslint -f junit -o "$HYDRA_TEST_OUTPUT/eslint.xml" .
  ```
- **Hydra-native JSON** (the general path, reliable for any tool) — emit cases with
  `"status": "warning"`:
  ```json
  { "cases": [ { "name": "no-unused-vars", "path": "src/x.ts", "line": 12, "status": "warning", "message": "'y' is defined but never used" } ] }
  ```

## Structured case locations

A `TestCase` carries a two-axis location besides its leaf `name`: `path` (repo-relative
file, or package dir for Go) with optional `line`/`col`/`end_line`/`end_col`, and
`scope` (a string array: class chain / describe chain / subtest parent). The JUnit
parser fills these itself — file-like classnames → `path`, dotted classnames
(`com.example.FooTest`, pytest) → `scope`, Go package classnames get the go.mod module
prefix stripped *and* are then resolved to the declaring `*_test.go` file + line by
scanning the package dir in the checkout (`locContext.resolveGoTestFile`; streamed
markers locating a package dir resolve the same way), pytest's native `file`/`line`
attrs are read (0-based line bumped) — and Hydra-JSON reports can set them directly.
The tests panel renders cases as a collapsible path tree with lowlit indent-guide
lines showing each row's parent; node tallies (`✓ ⚠ ✗`) always count everything under
a node, filters only hide rows. Default-hidden statuses depend on the view mode:
passed + skipped in the unified tree, nothing when "Group by result" is on (its
per-status sections render as root tree nodes; skipped/passing start collapsed).
Filter/search live in the Tests header; "Group by result" / "Group by scope"
checkboxes in the changes cog.

## Streaming results (`type = "stdout"`)

A `[tests.<name>]` runner with `type = "stdout"` skips report files entirely: Hydra parses
`::hydra:test:*::` markers live from the command's stdout, counts tick in the panel
and the sidebar chip while the run is in flight, and the accumulated cases become the
report at exit (no markers → exit-code fallback). One line per case — location
(`path[:line[:col]]` or dotted class) `›` optional scope levels `›` name, `|` message:

```bash
echo "::hydra:test:total:: 4556"                    # optional denominator
echo "::hydra:test:pass:: internal/artifacts › TestGenerateAndCache"
echo "::hydra:test:pass:38:: internal/artifacts › TestFast"   # 38 = duration in ms
echo "::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement"
echo "::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected kid-2 to be kid-3"
echo "::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon"
```

Use `::hydra:progress:: <text>` for an explicit phase headline while the runner
is between cases (for example, `::hydra:progress:: Installing dependencies`).
Hydra shows that headline in compact test status; ordinary stdout remains
available in the expanded live log but is not used as compact status.

**Durations.** A verb takes an optional `:<ms>` suffix, giving streamed cases the
timing a JUnit report already carries in its `time` attribute; the panel renders it
per case. It rides on the *verb* rather than the payload because the payload is user
text - a test name could contain any delimiter - whereas the verb is a closed set.
Omitting it stays valid, and a malformed or negative value drops the timing while
keeping the case.

## Bundled marker emitters

Three reporters in this repo turn a runner's native output into markers; copy one
when wiring up a new runner:

| Runner | Emitter | Notes |
| --- | --- | --- |
| `go test -json` | `scripts/gotest-markers` | package path as location, subtests as scope, `-total` mode counts a `-list` pass for the denominator |
| vitest | `web/scripts/hydra-reporter.ts` | describe chain as scope, rolling `total` as modules are collected |
| Playwright | `web/e2e/hydra-reporter.ts` | full spec count known up front, so `total` is declared in `onBegin`; a `flaky` outcome counts as a pass |

Two more emit findings that are not tests at all, onto the same verdict:
`web/scripts/eslint-report.ts` (lint) and `web/scripts/tsc-report.ts` (type errors).
Both map errors to `fail` (gates the merge) and warnings to `warn` (informational),
and both exit 0 - the markers carry the verdict, so only a crash goes non-zero.

`tsc-report.ts` is worth knowing about: typechecking used to gate nothing. `npm run
lint` was eslint alone and the `[tests.web]` runner never compiled, so a type error
reached `mage build` and nowhere else. `lint` now runs `tsc -b` first, and the runner
ends with `tsc-report.ts`.

**Prefer streaming over JUnit for slow suites.** A JUnit reporter writes its file
only at the end, so a run killed by `timeout_sec` reports *nothing* - the whole suite
reads as a bare red exit code. Streamed cases are kept as they arrive, so a partial
run still shows what passed. That is why the e2e suite moved off JUnit.
