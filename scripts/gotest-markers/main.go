// Command gotest-markers converts `go test -json` events (read from stdin) into
// Hydra streaming test markers (::hydra:test:*::) on stdout, so the Go suite can
// run as a type = "stdout" [[tests]] runner and stream per-case pass/fail/skip
// into the tests panel live (see internal/tests/stream.go for the marker format).
//
// It is the streaming analog of gotestsum's JUnit output: pipe `go test -json
// ./...` into it. The location token on each marker is the package import path;
// Hydra strips the go.mod module prefix itself (internal/tests/location.go), so
// `github.com/trolleyman/hydra/internal/artifacts` renders as internal/artifacts.
// Subtests (TestFoo/sub) become a scope chain (TestFoo › sub).
//
// It exits non-zero when any test failed (mirroring `go test`), so the usual
// `... | gotest-markers && <next>` chaining still gates the follow-up step.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"braces.dev/errtrace"
)

// event is one `go test -json` record (a subset of the fields we use).
type event struct {
	Action  string
	Package string
	Test    string
	Output  string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "gotest-markers: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 1<<20), 32<<20) // large lines: a test may print a lot

	testOut := map[string][]string{} // package\x00test -> output lines
	pkgOut := map[string][]string{}  // package -> package-level output lines
	testsSeen := map[string]bool{}   // package saw at least one test result
	failed := false

	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue // non-JSON noise (e.g. a build error banner) — ignore
		}
		var e event
		if err := json.Unmarshal(line, &e); err != nil {
			continue
		}

		if e.Test != "" {
			key := e.Package + "\x00" + e.Test
			switch e.Action {
			case "output":
				testOut[key] = append(testOut[key], e.Output)
			case "pass", "fail", "skip":
				testsSeen[e.Package] = true
				if e.Action == "fail" {
					failed = true
				}
				emitTest(e, testOut[key])
				delete(testOut, key)
			}
			continue
		}

		// Package-level record (Test == "").
		switch e.Action {
		case "output":
			pkgOut[e.Package] = append(pkgOut[e.Package], e.Output)
		case "fail":
			failed = true
			// Only surface a package-level failure when no test reported it —
			// i.e. a build/setup failure — so ordinary test failures aren't
			// duplicated by the package's "FAIL pkg" summary line.
			if !testsSeen[e.Package] {
				fmt.Println("::hydra:test:fail:: " + e.Package + " › (build) | " + escape(cleanMsg(pkgOut[e.Package])))
			}
			delete(pkgOut, e.Package)
		case "pass", "skip":
			delete(pkgOut, e.Package)
		}
	}
	if err := sc.Err(); err != nil {
		return errtrace.Wrap(err)
	}
	if failed {
		os.Exit(1)
	}
	return nil
}

// emitTest prints one ::hydra:test:*:: marker for a finished test. The package
// import path is the location token; "/"-separated subtest names become extra
// scope levels before the leaf name.
func emitTest(e event, out []string) {
	verb := e.Action // pass | fail | skip (already filtered by the caller)
	tokens := append([]string{e.Package}, strings.Split(e.Test, "/")...)
	line := "::hydra:test:" + verb + ":: " + strings.Join(tokens, " › ")
	if msg := escape(cleanMsg(out)); msg != "" && verb != "pass" {
		line += " | " + msg
	}
	fmt.Println(line)
}

// cleanMsg joins a test's captured output into a single message, dropping the
// `=== RUN`/`=== PAUSE`/`=== CONT`/`=== NAME` framing lines that carry no signal.
func cleanMsg(lines []string) string {
	var b strings.Builder
	for _, l := range lines {
		t := strings.TrimRight(l, "\n")
		switch trimmed := strings.TrimSpace(t); {
		case strings.HasPrefix(trimmed, "=== RUN"),
			strings.HasPrefix(trimmed, "=== PAUSE"),
			strings.HasPrefix(trimmed, "=== CONT"),
			strings.HasPrefix(trimmed, "=== NAME"):
			continue
		}
		b.WriteString(t)
		b.WriteByte('\n')
	}
	return strings.TrimSpace(b.String())
}

// escape encodes a message so it survives on one marker line: backslash first,
// then the whitespace controls Hydra's unescapeMessage decodes back (stream.go).
func escape(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, "\t", "\\t")
	s = strings.ReplaceAll(s, "\r", "\\r")
	return s
}
