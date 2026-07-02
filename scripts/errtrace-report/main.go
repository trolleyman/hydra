// Command errtrace-report runs errtrace (pinned via the go.mod tool directive)
// over the project's Go sources and reports what `mage tidy` would change: files
// whose returned errors aren't errtrace-wrapped, and unused //errtrace:skip
// directives. It is the Go analog of web/scripts/eslint-report.ts.
//
// By default it is read-only (errtrace -l) and writes a Hydra-native test report
// into $HYDRA_TEST_OUTPUT (see internal/tests for the shape) so the findings
// surface as amber ⚠ warnings on the head's test verdict — informational only,
// never gating the merge. Run without HYDRA_TEST_OUTPUT it just prints a summary.
// It exits 0 once the scan completes — the report, not the exit code, carries
// the findings — so a non-zero exit means errtrace itself could not run.
//
// With -w it instead rewrites the files in place (errtrace -w); `mage tidy`
// calls it this way so both modes share one file list.
package main

import (
	"bytes"
	"encoding/json"
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

	type testCase struct {
		Name    string `json:"name"`
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	cases := []testCase{}

	// stdout: one path per line — a file whose returned errors errtrace would rewrap.
	for _, f := range splitLines(stdout.String()) {
		cases = append(cases, testCase{
			Name:    "errtrace: " + f,
			Status:  "warning",
			Message: "returned errors are not errtrace-wrapped; run `mage tidy`",
		})
	}
	// stderr: "path:line:message" diagnostics, e.g. an unused skip directive.
	for _, line := range splitLines(stderr.String()) {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 {
			cases = append(cases, testCase{
				Name:    fmt.Sprintf("errtrace: %s:%s", parts[0], parts[1]),
				Status:  "warning",
				Message: strings.TrimSpace(parts[2]) + "; run `mage tidy` and fix its warnings",
			})
		} else {
			fmt.Fprintln(os.Stderr, line)
		}
	}

	if outDir := os.Getenv("HYDRA_TEST_OUTPUT"); outDir != "" {
		report, err := json.Marshal(map[string]any{"cases": cases})
		if err != nil {
			return errtrace.Wrap(err)
		}
		if err := os.WriteFile(filepath.Join(outDir, "errtrace.json"), report, 0o644); err != nil {
			return errtrace.Wrap(err)
		}
	}
	fmt.Printf("errtrace: %d warning(s) across %d files\n", len(cases), len(files))
	return nil
}

// goSourceFiles collects every .go file errtrace should process: the whole tree
// minus generated code (.gen.go) and non-source dirs, plus magefiles/ (excluded
// from ./... by its build tag). Kept here — not in the magefile — so `mage tidy`
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
