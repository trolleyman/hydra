package tests

import (
	"encoding/json"
	"encoding/xml"
	"os"
	"path/filepath"
	"sort"
	"strings"

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
func ParseDir(outputDir string) (cases []TestCase, format string, found bool, err error) {
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
			if c, ok := parseJUnit(data); ok {
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

// Summarize counts cases by outcome.
func Summarize(cases []TestCase) (passed, failed, skipped int) {
	for _, c := range cases {
		switch c.Status {
		case CaseFailed:
			failed++
		case CaseSkipped:
			skipped++
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
	Cases  []junitCase  `xml:"testcase"`
	Suites []junitSuite `xml:"testsuite"` // nested suites
}

type junitCase struct {
	Name      string        `xml:"name,attr"`
	Classname string        `xml:"classname,attr"`
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

func parseJUnit(data []byte) ([]TestCase, bool) {
	// JUnit files come with either a <testsuites> root or a bare <testsuite>.
	var roots junitSuites
	if err := xml.Unmarshal(data, &roots); err == nil && len(roots.Suites) > 0 {
		return flattenSuites(roots.Suites), true
	}
	var single junitSuite
	if err := xml.Unmarshal(data, &single); err == nil && (len(single.Cases) > 0 || len(single.Suites) > 0) {
		return flattenSuites([]junitSuite{single}), true
	}
	return nil, false
}

func flattenSuites(suites []junitSuite) []TestCase {
	var out []TestCase
	for _, s := range suites {
		for _, c := range s.Cases {
			out = append(out, junitCaseToTestCase(c))
		}
		out = append(out, flattenSuites(s.Suites)...)
	}
	return out
}

func junitCaseToTestCase(c junitCase) TestCase {
	name := strings.TrimSpace(c.Name)
	if cn := strings.TrimSpace(c.Classname); cn != "" && cn != name && !strings.Contains(name, cn) {
		name = cn + " › " + name
	}
	tc := TestCase{Name: name, Status: CasePassed, DurationMs: int64(c.Time * 1000)}
	switch {
	case len(c.Failures) > 0 || len(c.Errors) > 0:
		tc.Status = CaseFailed
		details := append(append([]junitDetail{}, c.Failures...), c.Errors...)
		tc.Message = truncate(joinDetails(details), maxCaseMessage)
	case c.Skipped != nil:
		tc.Status = CaseSkipped
		tc.Message = truncate(strings.TrimSpace(c.Skipped.Message), maxCaseMessage)
	}
	return tc
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

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
