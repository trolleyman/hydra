// Command errtrace-report runs errtrace (pinned via the go.mod tool directive)
// over the project's Go sources and reports what `mage tidy` would change: files
// whose returned errors aren't errtrace-wrapped, and unused //errtrace:skip
// directives. It is the Go analog of web/scripts/eslint-report.ts.
//
// By default it is read-only (errtrace -l) and emits Hydra streaming test
// markers (::hydra:test:warn:: on stdout, see internal/tests/stream.go) so the
// findings surface as amber ⚠ warnings on the head's test verdict -
// informational only, never gating the merge. It exits 0 once the scan
// completes - the markers, not the exit code, carry the findings - so a non-zero
// exit means errtrace itself could not run.
//
// With -w it instead rewrites the files in place (errtrace -w); `mage tidy`
// calls it this way so both modes share one file list.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
)

func main() {
	write := flag.Bool("w", false, "rewrite files in place (errtrace -w) instead of reporting")
	flag.Parse()

	if err := run(*write); err != nil {
		fmt.Fprintf(os.Stderr, "errtrace-report: %v\n", err)
		os.Exit(1)
	}
}

func run(write bool) error {
	files, err := goSourceFiles()
	if err != nil {
		return errtrace.Wrap(err)
	}

	if write {
		cmd := exec.Command("go", append([]string{"tool", "errtrace", "-w"}, files...)...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return errtrace.Wrap(cmd.Run())
	}

	cmd := exec.Command("go", append([]string{"tool", "errtrace", "-l"}, files...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("go tool errtrace -l: %w\n%s%s", err, stdout.String(), stderr.String()))
	}

	warnings := 0
	// stdout: one path per line - a file whose returned errors errtrace would rewrap.
	for _, f := range splitLines(stdout.String()) {
		fmt.Printf("::hydra:test:warn:: %s › errtrace | returned errors are not errtrace-wrapped; run `mage tidy`\n", f)
		warnings++
	}
	// stderr: "path:line:message" diagnostics, e.g. an unused skip directive.
	for _, line := range splitLines(stderr.String()) {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 {
			fmt.Printf("::hydra:test:warn:: %s:%s › errtrace | %s; run `mage tidy` and fix its warnings\n",
				parts[0], parts[1], strings.TrimSpace(parts[2]))
			warnings++
		} else {
			fmt.Fprintln(os.Stderr, line)
		}
	}

	fmt.Printf("errtrace: %d warning(s) across %d files\n", warnings, len(files))
	return nil
}

// goSourceFiles collects every .go file errtrace should process: the whole tree
// minus generated code (.gen.go) and non-source dirs, plus magefiles/ (excluded
// from ./... by its build tag). Kept here - not in the magefile - so `mage tidy`
// and the test-gate report always scan the same set.
func goSourceFiles() ([]string, error) {
	skipDirs := map[string]struct{}{
		".git": {}, "vendor": {}, "node_modules": {}, ".mage": {}, ".hydra": {},
	}
	var files []string
	err := filepath.Walk(".", func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return errtrace.Wrap(walkErr)
		}
		if info.IsDir() {
			if _, skip := skipDirs[info.Name()]; skip {
				return filepath.SkipDir //errtrace:skip // This error must be filepath.SkipDir, not wrapped.
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".gen.go") {
			files = append(files, path)
		}
		return nil
	})
	return files, errtrace.Wrap(err)
}

func splitLines(s string) []string {
	var out []string
	for line := range strings.SplitSeq(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}
