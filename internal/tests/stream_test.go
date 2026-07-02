package tests

import (
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
)

func TestParseTestMarker(t *testing.T) {
	lc := &locContext{}
	for _, tt := range []struct {
		line string
		want testMarker
		ok   bool
	}{
		{"::hydra:test:total:: 4556", testMarker{kind: "total", total: 4556}, true},
		{"::hydra:test:done::", testMarker{kind: "done"}, true},
		{
			"::hydra:test:pass:: internal/artifacts › TestGenerateAndCache",
			testMarker{kind: "case", c: TestCase{Status: CasePassed, Path: "internal/artifacts", Name: "TestGenerateAndCache"}},
			true,
		},
		{
			"::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement",
			testMarker{kind: "case", c: TestCase{Status: CaseWarning, Path: "web/src/x.ts", Line: 12, Col: 5, Name: "no-console", Message: "Unexpected console statement"}},
			true,
		},
		{
			"::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected kid-2 to be kid-3",
			testMarker{kind: "case", c: TestCase{Status: CaseFailed, Path: "auth/rotation.test.ts", Line: 48, Col: 24, Name: "grace window", Message: "expected kid-2 to be kid-3"}},
			true,
		},
		{
			"::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon",
			testMarker{kind: "case", c: TestCase{Status: CaseSkipped, Path: "heads/resume_test.go", Name: "TestResumeOnBoot", Message: "needs daemon"}},
			true,
		},
		// Dotted class chains route to Scope via the shared classifier; extra ›
		// tokens append as further scope levels.
		{
			"::hydra:test:pass:: com.example.FooTest › testBar",
			testMarker{kind: "case", c: TestCase{Status: CasePassed, Scope: []string{"com", "example", "FooTest"}, Name: "testBar"}},
			true,
		},
		{
			"::hydra:test:pass:: src/api/x.test.ts › formatError › includes chain",
			testMarker{kind: "case", c: TestCase{Status: CasePassed, Path: "src/api/x.test.ts", Scope: []string{"formatError"}, Name: "includes chain"}},
			true,
		},
		// Name-only case (no location).
		{"::hydra:test:pass:: just a name", testMarker{kind: "case", c: TestCase{Status: CasePassed, Name: "just a name"}}, true},
		// Escapes in the message decode to real control chars so a single marker
		// line can carry a multi-line failure; `\\` collapses to one backslash and
		// an unknown escape is left verbatim.
		{
			"::hydra:test:fail:: pkg/a › TestX | line1\\nline2\\tcol\\\\path \\q raw",
			testMarker{kind: "case", c: TestCase{Status: CaseFailed, Path: "pkg/a", Name: "TestX", Message: "line1\nline2\tcol\\path \\q raw"}},
			true,
		},
		// Rejections: unknown verb, empty payload, plain output.
		{"::hydra:test:bogus:: x", testMarker{}, false},
		{"::hydra:test:pass::", testMarker{}, false},
		{"ordinary line", testMarker{}, false},
		{"::hydra:progress:: 4/10", testMarker{}, false},
	} {
		got, ok := parseTestMarker(tt.line, lc)
		if ok != tt.ok {
			t.Errorf("parseTestMarker(%q) ok = %v, want %v", tt.line, ok, tt.ok)
			continue
		}
		if !ok {
			continue
		}
		if got.kind != tt.want.kind || got.total != tt.want.total {
			t.Errorf("parseTestMarker(%q) = %+v, want %+v", tt.line, got, tt.want)
		}
		if got.kind != "case" {
			continue
		}
		g, w := got.c, tt.want.c
		if g.Status != w.Status || g.Path != w.Path || g.Name != w.Name || g.Message != w.Message ||
			g.Line != w.Line || g.Col != w.Col || !equalStrs(g.Scope, w.Scope) {
			t.Errorf("parseTestMarker(%q) case = %+v, want %+v", tt.line, g, w)
		}
	}
}

// A streamed marker locating a Go package dir resolves to the declaring
// *_test.go file + line when the checkout is on disk, like JUnit Go cases.
func TestParseTestMarkerResolvesGoFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "internal", "tests", "stream_test.go"),
		"package tests\n\nimport \"testing\"\n\nfunc TestMarkers(t *testing.T) {}\n")
	lc := newLocContext(dir)

	got, ok := parseTestMarker("::hydra:test:pass:: internal/tests › TestMarkers › sub case", lc)
	if !ok {
		t.Fatal("expected marker to parse")
	}
	if got.c.Path != "internal/tests/stream_test.go" || got.c.Line != 5 ||
		!equalStrs(got.c.Scope, []string{"TestMarkers"}) || got.c.Name != "sub case" {
		t.Errorf("case = %+v, want path internal/tests/stream_test.go line 5", got.c)
	}

	// A dir with no *_test.go (not a Go package) is left untouched.
	got, ok = parseTestMarker("::hydra:test:pass:: internal/other › TestMarkers", lc)
	if !ok || got.c.Path != "internal/other" || got.c.Line != 0 {
		t.Errorf("case = %+v, want unresolved package-dir path", got.c)
	}
}

// A type=stdout runner's accumulated markers become the report — no file read —
// and coalesced "counts" events stream the increments.
func TestGenerateStreamingMarkers(t *testing.T) {
	script := `
echo "::hydra:test:total:: 4"
echo "::hydra:test:pass:: pkg/a › TestOne"
echo "::hydra:test:fail:: pkg/a › TestTwo | boom"
echo "::hydra:test:warn:: web/x.ts:3:1 › no-console | tut tut"
echo "::hydra:test:skip:: pkg/b › TestThree | later"
echo "plain log line"
`
	workDir := t.TempDir()
	initGitRepo(t, workDir)
	m := NewManager(t.TempDir())
	events, unsub := m.Subscribe()
	defer unsub()

	spec := config.TestScript{Name: "t", UnsafeHost: true, Type: "stdout", Command: script}
	v := Version{WorktreeDir: workDir}
	if _, err := m.Get(spec, v); err != nil {
		t.Fatalf("Get: %v", err)
	}
	var counts *RunningCounts
	for ev := range events {
		if ev.Kind == "counts" && ev.Counts != nil {
			// Keep the last one — totals are cumulative.
			counts = ev.Counts
		}
		if ev.Kind == "settled" {
			break
		}
	}
	if counts == nil {
		t.Fatal("no counts event observed")
	}
	if counts.Passed+counts.Failed+counts.Skipped+counts.Warnings != 4 || counts.Total != 4 {
		t.Errorf("final counts = %+v, want 4 cases with total 4", counts)
	}

	rep, ok, err := m.Peek(spec.Name, v)
	if err != nil || !ok {
		t.Fatalf("Peek after settle: ok=%v err=%v", ok, err)
	}
	if rep.Status != StatusFailing {
		t.Errorf("status = %s, want failing (a fail marker was streamed)", rep.Status)
	}
	if rep.Format != "stdout" {
		t.Errorf("format = %q, want stdout", rep.Format)
	}
	if rep.Passed != 1 || rep.Failed != 1 || rep.Skipped != 1 || rep.Warnings != 1 || rep.Total != 4 {
		t.Errorf("summary = %d/%d/%d/%d total %d, want 1/1/1/1 total 4", rep.Passed, rep.Failed, rep.Skipped, rep.Warnings, rep.Total)
	}
	var warn *TestCase
	for i := range rep.Cases {
		if rep.Cases[i].Status == CaseWarning {
			warn = &rep.Cases[i]
		}
	}
	if warn == nil || warn.Path != "web/x.ts" || warn.Line != 3 || warn.Col != 1 || warn.Name != "no-console" || warn.Message != "tut tut" {
		t.Errorf("warning case = %+v, want structured location from the marker", warn)
	}
}

// The declared ::hydra:test:total:: denominator is a floor, not a cap: a
// runner can only count what's listable upfront (Go subtests aren't), so when
// the streamed cases overshoot it the denominator grows instead of the
// progress rendering "3/2".
func TestDeclaredTotalIsAFloor(t *testing.T) {
	lr := &liveRun{total: 2, cases: make([]TestCase, 1)}
	if got := lr.progressText(); got != "1/2" {
		t.Errorf("progressText under total = %q, want 1/2", got)
	}
	lr.cases = make([]TestCase, 3)
	if got := lr.progressText(); got != "3/3" {
		t.Errorf("progressText over total = %q, want 3/3", got)
	}
	lr.total = 0
	if got := lr.progressText(); got != "3" {
		t.Errorf("progressText without total = %q, want bare count", got)
	}
}

// A type=stdout runner that emits no markers falls back to the exit-code
// verdict, exactly like a junit runner that wrote no report.
func TestGenerateStreamingNoMarkersFallsBack(t *testing.T) {
	rep := runWorktree(t, config.TestScript{Name: "t", UnsafeHost: true, Type: "stdout", Command: "true"}, t.TempDir())
	if rep.Status != StatusPassing || rep.Format != "exit" {
		t.Errorf("report = %+v, want passing via exit fallback", rep)
	}
}
