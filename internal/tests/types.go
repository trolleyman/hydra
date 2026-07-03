// Package tests runs a project's [[tests]] commands against a checkout and parses
// their reports into a pass/fail verdict that gates a head's merge button (see
// PLAN #68). It reuses the artifacts generation pipeline wholesale — the bounded
// worktree-slot pool, the priority scheduler, the per-commit cache, and the live
// log/progress stream — swapping only the post-run step: instead of scanning
// image outputs it parses a JUnit-XML or Hydra-JSON test report.
package tests

// Status is a settled-or-in-flight test verdict. The persisted report is one of
// passing/failing/errored; running is the synthetic status of an in-flight run.
type Status string

const (
	// StatusRunning: a generation is in flight (not yet settled).
	StatusRunning Status = "running"
	// StatusPassing: the run produced a report with zero failing cases.
	StatusPassing Status = "passing"
	// StatusFailing: the run produced a report with at least one failing case.
	StatusFailing Status = "failing"
	// StatusErrored: the command could not produce a verdict (failed to start,
	// timed out, or wrote a malformed report). Distinct from failing — it means
	// "we don't know", not "tests are red". Retryable via Invalidate.
	StatusErrored Status = "errored"
)

// CaseStatus is the outcome of a single test case.
type CaseStatus string

const (
	CasePassed  CaseStatus = "passed"
	CaseFailed  CaseStatus = "failed"
	CaseSkipped CaseStatus = "skipped"
	// CaseWarning is a non-failing diagnostic (e.g. an eslint warning, a
	// deprecation notice). It never flips the verdict to failing — it's surfaced
	// informationally as its own count alongside passed/failed/skipped.
	CaseWarning CaseStatus = "warning"
)

// ScopeKind classifies one Scope level (parallel to a case's Scope entries).
// The distinction is only knowable while parsing — a describe block, a class
// and a Go test function are indistinguishable strings once collapsed — so the
// parsers tag it here rather than leaving consumers to guess.
type ScopeKind string

const (
	// ScopeModule is a container level: a vitest/jest describe block, a
	// package/namespace segment of a dotted class chain, a test suite. The
	// common case.
	ScopeModule ScopeKind = "module"
	// ScopeFunction is a Go test function that owns subtests (its parent level,
	// resolved to a `func TestXxx` declaration). What a parametrized/subtest
	// grouping hangs off.
	ScopeFunction ScopeKind = "function"
	// ScopeClass is a class/type level in a dotted class chain — the JUnit/Java
	// `com.example.FooTest`, a pytest `TestClass`, a Kotlin object. Detected by
	// its class-shaped identifier (PascalCase, no spaces) so a package segment
	// (lowercase `org.trolleyman`) stays a ScopeModule.
	ScopeClass ScopeKind = "class"
)

// TestCase is one parsed test case. Message carries the failure/assertion text
// for a failed case (and the skip reason for a skipped one, when present).
//
// Location is split into two axes: Path is a *filesystem* location (a
// repo-relative file, or a package dir for Go where the report doesn't expose
// the file) — copyable and deep-linkable, optionally carrying line/col. Scope
// is the *logical* nesting chain between the path and the leaf name: a Java
// class chain, a pytest class, a vitest describe chain, a Go subtest parent.
// It's an array (not a joined string) because file names contain dots — a
// single separator-polymorphic string can't be split back apart reliably.
// Old cached reports carry a pre-joined Name and no Path/Scope; consumers fall
// back to the flat Name.
type TestCase struct {
	Name   string     `json:"name"`
	Status CaseStatus `json:"status"`
	Path   string     `json:"path,omitempty"`
	Scope  []string   `json:"scope,omitempty"`
	// ScopeKinds is parallel to Scope: the ScopeKind of each level ("module" |
	// "function"). Empty or shorter than Scope for old reports / runners that
	// don't tag it — consumers treat a missing level as ScopeModule.
	ScopeKinds []string `json:"scope_kinds,omitempty"`
	Line       int      `json:"line,omitempty"` // 1-based; 0 = unknown
	Col        int      `json:"col,omitempty"`
	EndLine    int      `json:"end_line,omitempty"`
	EndCol     int      `json:"end_col,omitempty"`
	DurationMs int64    `json:"duration_ms"`
	Message    string   `json:"message,omitempty"`
	// PathMissing flags a case whose Path names a file absent from the checkout
	// the report was parsed against — a stale or incorrect location in the
	// runner's output that would deep-link nowhere. Purely informational: it
	// never flips the verdict or feeds the warnings count; the UI just marks the
	// file row so the broken location is visible. Only set for file-like paths
	// under a known checkout (Go package dirs and locationless cases stay false).
	PathMissing bool `json:"path_missing,omitempty"`
}

// LogLine is one captured output line of an in-flight generation.
type LogLine struct {
	Text   string `json:"text"`
	Stream string `json:"stream"` // StreamStdout | StreamStderr
}

const (
	StreamStdout = "stdout"
	StreamStderr = "stderr"
)

// Report is the persisted result of one test run (the tests analog of
// artifacts.Meta), written as report.json in the cache entry dir. The transient
// fields (json:"-") describe an in-flight run and are never persisted.
type Report struct {
	Runner   string `json:"runner"`        // the [[tests]] script name
	Key      string `json:"key"`           // cache key ("commit/<sha>" | "worktree/<hash>")
	Ref      string `json:"ref,omitempty"` // human-readable ref (the resolved SHA)
	Status   Status `json:"status"`        // passing | failing | errored
	Total    int    `json:"total"`         // passed+failed+skipped+warnings
	Passed   int    `json:"passed"`
	Failed   int    `json:"failed"`
	Skipped  int    `json:"skipped"`
	Warnings int    `json:"warnings"` // non-failing diagnostics; informational only

	DurationMs int64      `json:"duration_ms"` // wall-clock of the whole command
	Cases      []TestCase `json:"cases,omitempty"`
	Error      string     `json:"error,omitempty"`  // populated when Status==errored
	Format     string     `json:"format,omitempty"` // junit | hydra | exit
	UpdatedAt  int64      `json:"updated_at"`

	// Transient (in-flight only; never written to report.json).
	Progress  string    `json:"-"`
	StartedAt int64     `json:"-"`
	Log       []LogLine `json:"-"`
}

// Version selects which checkout a test runs against, mirroring artifacts.Version:
// a committed ref (cached by resolved SHA, shareable across heads) or a working
// tree directory (cached by a content fingerprint).
type Version struct {
	Ref         string
	WorktreeDir string
}

// Event is a generation lifecycle notification delivered to Subscribe listeners.
// Kind is "log", "progress", "counts", or "settled" — the artifacts vocabulary
// plus "counts", the streamed-tests increment (see RunningCounts).
type Event struct {
	Dir      string
	Kind     string
	Line     LogLine
	Progress string
	Counts   *RunningCounts // kind == "counts"
}

// RunningCounts is the payload of a "counts" event: an in-flight run's totals
// so far plus the cases appended since the previous event. Events are
// coalesced (~10×/s or every caseFlushMax cases) so a 4,556-case run doesn't
// emit 4,556 WS frames.
type RunningCounts struct {
	Passed   int
	Failed   int
	Skipped  int
	Warnings int
	Total    int // declared ::hydra:test:total:: denominator (0 = unknown)
	Cases    []TestCase
}
