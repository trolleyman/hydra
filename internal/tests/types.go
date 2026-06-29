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
)

// TestCase is one parsed test case. Message carries the failure/assertion text
// for a failed case (and the skip reason for a skipped one, when present).
type TestCase struct {
	Name       string     `json:"name"`
	Status     CaseStatus `json:"status"`
	DurationMs int64      `json:"duration_ms"`
	Message    string     `json:"message,omitempty"`
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
	Runner     string     `json:"runner"`         // the [[tests]] script name
	Key        string     `json:"key"`            // cache key ("commit/<sha>" | "worktree/<hash>")
	Ref        string     `json:"ref,omitempty"`  // human-readable ref (the resolved SHA)
	Status     Status     `json:"status"`         // passing | failing | errored
	Total      int        `json:"total"`          // passed+failed+skipped
	Passed     int        `json:"passed"`
	Failed     int        `json:"failed"`
	Skipped    int        `json:"skipped"`
	DurationMs int64      `json:"duration_ms"`    // wall-clock of the whole command
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
// Kind is "log", "progress", or "settled" — the same vocabulary as artifacts so
// the WS/poll plumbing maps over identically.
type Event struct {
	Dir      string
	Kind     string
	Line     LogLine
	Progress string
}
