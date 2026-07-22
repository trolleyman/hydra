# Testing internals - the agent test gate

Run the Go suite with standard tooling: `go test ./...`.

This doc covers how Hydra ingests and renders a project's `[tests.<name>]` runner
output. You only need it when touching `internal/tests`, the tests panel
(`web/src`), or a project's test-runner config.

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
echo "::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement"
echo "::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected kid-2 to be kid-3"
echo "::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon"
```
