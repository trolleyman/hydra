package tests

import (
	"encoding/json"
	"encoding/xml"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"braces.dev/errtrace"
)

// maxCaseMessage bounds a stored per-case failure message so a runaway stack
// trace can't bloat report.json (the full log is still available separately).
const maxCaseMessage = 4000

// ParseDir scans outputDir for test-report files and returns the parsed cases
// plus the report format ("junit", "hydra", or "" when nothing parseable was
// found). Hydra-native JSON (*.json) and JUnit XML (*.xml) files are both
// accepted and aggregated; the format string reflects what was actually read
// (mixed → "junit+hydra"). A directory with no report files returns
// (nil, "", false, nil) so the caller can fall back to the exit code.
//
// checkoutDir is the source tree the tests ran against; it's used only to
// normalize case locations (relativize absolute paths, strip the Go module
// prefix off package classnames) and may be "" to skip that.
func ParseDir(outputDir, checkoutDir string) (cases []TestCase, format string, found bool, err error) {
	entries, derr := os.ReadDir(outputDir)
	if derr != nil {
		if os.IsNotExist(derr) {
			return nil, "", false, nil
		}
		return nil, "", false, errtrace.Wrap(derr)
	}
	// Deterministic order so aggregated cases are stable across runs.
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	lc := newLocContext(checkoutDir)
	sawJUnit, sawHydra := false, false
	for _, name := range names {
		ext := strings.ToLower(filepath.Ext(name))
		if ext != ".xml" && ext != ".json" {
			continue
		}
		data, rerr := os.ReadFile(filepath.Join(outputDir, name))
		if rerr != nil {
			continue // best-effort: skip an unreadable file
		}
		switch ext {
		case ".json":
			if c, ok := parseHydraJSON(data); ok {
				cases = append(cases, c...)
				sawHydra = true
				found = true
			}
		case ".xml":
			if c, ok := parseJUnit(data, lc); ok {
				cases = append(cases, c...)
				sawJUnit = true
				found = true
			}
		}
	}
	switch {
	case sawJUnit && sawHydra:
		format = "junit+hydra"
	case sawJUnit:
		format = "junit"
	case sawHydra:
		format = "hydra"
	}
	return cases, format, found, nil
}

// Summarize counts cases by outcome. Warnings are their own bucket - a warning
// case is NOT counted as passed.
func Summarize(cases []TestCase) (passed, failed, skipped, warnings int) {
	for _, c := range cases {
		switch c.Status {
		case CaseFailed:
			failed++
		case CaseSkipped:
			skipped++
		case CaseWarning:
			warnings++
		default:
			passed++
		}
	}
	return
}

// hydraReport is the Hydra-native JSON report shape a runner may write directly.
type hydraReport struct {
	Cases []TestCase `json:"cases"`
}

func parseHydraJSON(data []byte) ([]TestCase, bool) {
	var r hydraReport
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, false
	}
	out := make([]TestCase, 0, len(r.Cases))
	for _, c := range r.Cases {
		c.Status = normalizeCaseStatus(string(c.Status))
		c.Message = truncate(c.Message, maxCaseMessage)
		out = append(out, c)
	}
	return out, true
}

func normalizeCaseStatus(s string) CaseStatus {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "fail", "failed", "failure", "error", "errored":
		return CaseFailed
	case "skip", "skipped", "pending", "ignored":
		return CaseSkipped
	case "warn", "warning", "warned":
		return CaseWarning
	default:
		return CasePassed
	}
}

// --- JUnit XML ---

type junitSuites struct {
	Suites []junitSuite `xml:"testsuite"`
}

type junitSuite struct {
	Name   string       `xml:"name,attr"`
	File   string       `xml:"file,attr"` // some emitters (vitest) put the file on the suite
	Cases  []junitCase  `xml:"testcase"`
	Suites []junitSuite `xml:"testsuite"` // nested suites
}

type junitCase struct {
	Name      string        `xml:"name,attr"`
	Classname string        `xml:"classname,attr"`
	File      string        `xml:"file,attr"` // pytest, jest-junit (addFileAttribute)
	Line      string        `xml:"line,attr"` // pytest (0-based)
	Time      float64       `xml:"time,attr"`
	Failures  []junitDetail `xml:"failure"`
	Errors    []junitDetail `xml:"error"`
	Skipped   *junitDetail  `xml:"skipped"`
}

type junitDetail struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Body    string `xml:",chardata"`
}

func parseJUnit(data []byte, lc *locContext) ([]TestCase, bool) {
	// JUnit files come with either a <testsuites> root or a bare <testsuite>.
	var roots junitSuites
	if err := xml.Unmarshal(data, &roots); err == nil && len(roots.Suites) > 0 {
		return flattenSuites(roots.Suites, suiteCtx{}, lc), true
	}
	var single junitSuite
	if err := xml.Unmarshal(data, &single); err == nil && (len(single.Cases) > 0 || len(single.Suites) > 0) {
		return flattenSuites([]junitSuite{single}, suiteCtx{}, lc), true
	}
	return nil, false
}

// suiteCtx is the enclosing-suite context inherited by nested suites/cases: a
// suite-level file attribute, and the root suite name (used to detect pytest's
// 0-based line attribute).
type suiteCtx struct {
	file     string
	rootName string
}

func flattenSuites(suites []junitSuite, ctx suiteCtx, lc *locContext) []TestCase {
	var out []TestCase
	for _, s := range suites {
		sctx := ctx
		if sctx.rootName == "" {
			sctx.rootName = strings.TrimSpace(s.Name)
		}
		if f := strings.TrimSpace(s.File); f != "" {
			sctx.file = f
		}
		for _, c := range s.Cases {
			out = append(out, junitCaseToTestCase(c, sctx, lc))
		}
		out = append(out, flattenSuites(s.Suites, sctx, lc)...)
	}
	return out
}

func junitCaseToTestCase(c junitCase, ctx suiteCtx, lc *locContext) TestCase {
	name := strings.TrimSpace(c.Name)
	loc := lc.classify(c.Classname)

	// A file attribute (pytest natively, jest-junit's addFileAttribute, vitest's
	// suite-level file) beats whatever the classname classified to: it's the
	// real file, exact and heuristic-free.
	if f := strings.TrimSpace(c.File); f != "" {
		loc.Path, _ = lc.normalizePath(f)
		loc.goPkg = false
	} else if loc.Path == "" && ctx.file != "" {
		loc.Path, _ = lc.normalizePath(ctx.file)
	}
	// With both a real file and a dotted classname (pytest), the classname's
	// leading segments usually just re-encode the file path - drop them.
	loc.Scope = dedupeScope(loc.Path, loc.Scope)

	tc := TestCase{Name: name, Status: CasePassed, Path: loc.Path, Scope: loc.Scope, DurationMs: int64(c.Time * 1000)}

	if c.Line != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(c.Line)); err == nil && n >= 0 {
			// pytest's junitxml line attribute is 0-based; no other mainstream
			// emitter sets it, so key the adjustment off the default suite name.
			if strings.EqualFold(ctx.rootName, "pytest") {
				n++
			}
			tc.Line = n
		}
	}

	switch {
	case loc.goPkg:
		// gotestsum: the classname was a Go package import path, so the name is
		// a Go test identifier - "TestFoo/sub/case" nests subtests as scope.
		if segs := strings.Split(name, "/"); len(segs) > 1 {
			tc.Scope = append(tc.Scope, segs[:len(segs)-1]...)
			tc.Name = segs[len(segs)-1]
		}
		// go test only knows the package; find the declaring *_test.go file
		// (+ line) in the checkout so Go cases tree by file too.
		lc.resolveGoTestFile(&tc, true)
	case loc.Path != "":
		// vitest/jest join the describe chain into the name with " > " - split
		// it back into scope levels. Only applied under a real file path, so
		// e.g. a bare Go subtest name is never mangled.
		if segs := strings.Split(name, " > "); len(segs) > 1 {
			tc.Scope = append(tc.Scope, mapTrimSpace(segs[:len(segs)-1])...)
			tc.Name = strings.TrimSpace(segs[len(segs)-1])
		}
	}
	// Tag each scope level's kind. A Go package classname (goPkg) means every
	// scope level is a test *function* (the split "TestFoo/sub" parents); every
	// other shape - a describe chain, a class chain - is a *module*. The two
	// origins never mix within one case, so the whole chain shares one kind.
	tc.ScopeKinds = scopeKindsFor(tc.Scope, loc.goPkg)

	switch {
	case len(c.Failures) > 0 || len(c.Errors) > 0:
		details := append(append([]junitDetail{}, c.Failures...), c.Errors...)
		// A case whose every failure/error is flagged type="warning" (e.g. eslint's
		// junit formatter for warning-severity messages) is a non-failing warning,
		// not a red failure.
		if allWarnings(details) {
			tc.Status = CaseWarning
		} else {
			tc.Status = CaseFailed
		}
		tc.Message = truncate(joinDetails(details), maxCaseMessage)
	case c.Skipped != nil:
		tc.Status = CaseSkipped
		tc.Message = truncate(strings.TrimSpace(c.Skipped.Message), maxCaseMessage)
	}
	return tc
}

// allWarnings reports whether every detail is explicitly typed as a warning
// (case-insensitive substring "warn"). An empty slice is not a warning.
func allWarnings(details []junitDetail) bool {
	if len(details) == 0 {
		return false
	}
	for _, d := range details {
		if !strings.Contains(strings.ToLower(d.Type), "warn") {
			return false
		}
	}
	return true
}

func joinDetails(details []junitDetail) string {
	var parts []string
	for _, d := range details {
		head := strings.TrimSpace(d.Message)
		body := strings.TrimSpace(d.Body)
		switch {
		case head != "" && body != "":
			parts = append(parts, head+"\n"+body)
		case head != "":
			parts = append(parts, head)
		case body != "":
			parts = append(parts, body)
		}
	}
	return strings.Join(parts, "\n")
}

func mapTrimSpace(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		out = append(out, strings.TrimSpace(s))
	}
	return out
}

// scopeKindsFor builds the ScopeKinds slice parallel to `scope`. A Go package
// classname (goPkg) means every level is a test *function* parent
// (`TestFoo/sub`). Otherwise each level is classified on its own: a
// class-shaped segment (PascalCase, no spaces - a JUnit/Java class, a pytest
// TestClass) is a ScopeClass, and everything else (a lowercase package segment,
// a describe block phrased as a sentence) stays a ScopeModule. Returns nil for
// an empty scope so the field stays omitted.
func scopeKindsFor(scope []string, goPkg bool) []string {
	if len(scope) == 0 {
		return nil
	}
	out := make([]string, len(scope))
	for i, seg := range scope {
		switch {
		case goPkg:
			out[i] = string(ScopeFunction)
		case looksLikeClass(seg):
			out[i] = string(ScopeClass)
		default:
			out[i] = string(ScopeModule)
		}
	}
	return out
}

// looksLikeClass reports whether a scope segment reads like a class/type name
// rather than a package segment or a describe phrase: a single identifier that
// starts with an uppercase letter (CodesTest, ConjugationDeckTest). A lowercase
// package (`org`, `trolleyman`) or a spaced describe block ("key rotation") is
// not a class.
func looksLikeClass(seg string) bool {
	if seg == "" || strings.ContainsAny(seg, " \t") {
		return false
	}
	return unicode.IsUpper([]rune(seg)[0])
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
