package tests

import (
	"regexp"
	"strconv"
	"strings"
)

// TestMarkerPrefix prefixes a stdout line a streaming (type = "stdout") test
// runner emits to report one case - or run metadata - live, extending the
// ::hydra:progress:: mechanism (same line scanner, same event fan-out):
//
//	::hydra:test:total:: 4556                          (optional denominator)
//	::hydra:test:pass:: internal/artifacts › TestGenerateAndCache
//	::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement
//	::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected kid-2 to be kid-3
//	::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon
//	::hydra:test:done::                                (optional; process exit settles anyway)
//
// The token before the first › is the location - a file/dir path (optionally
// :line:col-suffixed) or a dotted class chain, routed through the same
// classifier as JUnit classnames - middle › tokens are extra scope levels, the
// last is the leaf name, and everything after | is the message.
const TestMarkerPrefix = "::hydra:test:"

// testMarker is one parsed ::hydra:test:*:: line.
type testMarker struct {
	kind  string   // "case" | "total" | "done"
	c     TestCase // kind == "case"
	total int      // kind == "total"
}

// markerStatus maps the marker verb to a case status. Unknown verbs are
// rejected so ordinary output that happens to start with the prefix (e.g. a
// runner echoing its own docs) can't inject cases.
var markerStatus = map[string]CaseStatus{
	"pass": CasePassed,
	"fail": CaseFailed,
	"warn": CaseWarning,
	"skip": CaseSkipped,
}

// lineColRe strips an optional trailing :line[:col] off a location token.
var lineColRe = regexp.MustCompile(`^(.+?):(\d+)(?::(\d+))?$`)

// unescapeMessage decodes a small set of C-style escapes in a streamed case
// message, so a runner can carry a multi-line failure (stack trace, diff) on the
// single stdout line the marker protocol allows. Each ::hydra:test:*:: marker is
// one line - a raw newline would end it - so a runner emits `\n` and Hydra turns
// it back into a real newline here (the tests panel renders the message verbatim,
// like a JUnit <failure> body). Recognised: `\n` → newline, `\t` → tab, `\r` →
// carriage return, `\\` → a single backslash (so a literal backslash survives).
// An unrecognised escape (`\x`) is left untouched, backslash and all, so ordinary
// text - Windows paths, regexes - is never silently mangled.
func unescapeMessage(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s // fast path: nothing to decode
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		switch s[i+1] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case '\\':
			b.WriteByte('\\')
		default:
			// Unknown escape: keep both bytes verbatim.
			b.WriteByte('\\')
			b.WriteByte(s[i+1])
		}
		i++ // consumed the escaped byte
	}
	return b.String()
}

// parseTestMarker parses one raw stdout line as a test marker, returning
// ok=false when it isn't one (wrong prefix, unknown verb, empty payload).
func parseTestMarker(line string, lc *locContext) (testMarker, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(line), TestMarkerPrefix)
	if !ok {
		return testMarker{}, false
	}
	verb, payload, ok := strings.Cut(rest, "::")
	if !ok {
		return testMarker{}, false
	}
	payload = strings.TrimSpace(payload)
	switch verb {
	case "done":
		return testMarker{kind: "done"}, true
	case "total":
		n, err := strconv.Atoi(payload)
		if err != nil || n < 0 {
			return testMarker{}, false
		}
		return testMarker{kind: "total", total: n}, true
	}
	status, known := markerStatus[verb]
	if !known || payload == "" {
		return testMarker{}, false
	}

	// Split off the message first (everything after the first " | ").
	rest2, msg, _ := strings.Cut(payload, " | ")
	tc := TestCase{Status: status, Message: truncate(unescapeMessage(strings.TrimSpace(msg)), maxCaseMessage)}

	segs := mapTrimSpace(strings.Split(rest2, " › "))
	tc.Name = segs[len(segs)-1]
	if len(segs) > 1 {
		// First token = location (path or class chain, optional :line:col);
		// middle tokens = extra scope levels.
		locTok := segs[0]
		if m := lineColRe.FindStringSubmatch(locTok); m != nil {
			// Only treat the suffix as line:col when the prefix looks like a
			// file - `com.example.FooTest:2` is unlikely but a bare name with
			// a colon is; classify decides below either way.
			if n, err := strconv.Atoi(m[2]); err == nil {
				locTok = m[1]
				tc.Line = n
				if m[3] != "" {
					if c, err := strconv.Atoi(m[3]); err == nil {
						tc.Col = c
					}
				}
			}
		}
		loc := lc.classify(locTok)
		tc.Path = loc.Path
		tc.Scope = append(loc.Scope, segs[1:len(segs)-1]...)
		// A Go-package location means the scope levels are function parents; any
		// other shape is a describe/class module chain (see scopeKindsFor).
		tc.ScopeKinds = scopeKindsFor(tc.Scope, loc.goPkg)
		if tc.Path == "" {
			tc.Line, tc.Col = 0, 0 // line/col are meaningless without a file
		}
	}
	if tc.Name == "" {
		return testMarker{}, false
	}
	// A marker that located a Go *package dir* (e.g. "internal/tests ›
	// TestFoo") resolves to the declaring *_test.go file, like JUnit Go cases.
	lc.resolveGoTestFile(&tc, false)
	return testMarker{kind: "case", c: tc}, true
}
