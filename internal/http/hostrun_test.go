package http

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
)

func TestRunApprovedHostCommand(t *testing.T) {
	dir := t.TempDir()
	worktree := t.TempDir()

	// Runs in the worktree, output relayed, exit code propagated.
	runApprovedHostCommand(dir, "ok", worktree, "pwd && echo hi")
	res, ok, err := gate.ReadHostRunResult(dir, "ok")
	if err != nil || !ok {
		t.Fatalf("read result: ok=%v err=%v", ok, err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code: got %d want 0 (output=%q)", res.ExitCode, res.Output)
	}
	// pwd resolves symlinks (e.g. /tmp -> /private/tmp on macOS), so match on the
	// final path element rather than the full temp path.
	if !strings.Contains(res.Output, filepath.Base(worktree)) {
		t.Fatalf("expected output to include the worktree dir, got %q", res.Output)
	}
	if !strings.Contains(res.Output, "hi") {
		t.Fatalf("expected echoed output, got %q", res.Output)
	}
}

func TestRunApprovedHostCommandNonZeroExit(t *testing.T) {
	dir := t.TempDir()
	runApprovedHostCommand(dir, "fail", t.TempDir(), "echo oops >&2; exit 7")
	res, _, _ := gate.ReadHostRunResult(dir, "fail")
	if res.ExitCode != 7 {
		t.Fatalf("exit code: got %d want 7", res.ExitCode)
	}
	if !strings.Contains(res.Output, "oops") {
		t.Fatalf("stderr should be relayed too, got %q", res.Output)
	}
}

func TestRunApprovedHostCommandNoWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	runApprovedHostCommand(dir, "nw", "", "echo hi")
	res, ok, _ := gate.ReadHostRunResult(dir, "nw")
	if !ok || res.Error == "" || res.ExitCode == 0 {
		t.Fatalf("missing working directory should yield an error result, got ok=%v %+v", ok, res)
	}
}

func TestCapTail(t *testing.T) {
	if got := capTail("hello", 10); got != "hello" {
		t.Fatalf("short string should pass through, got %q", got)
	}
	if got := capTail("0123456789", 4); got != "6789" {
		t.Fatalf("expected the tail, got %q", got)
	}
}
