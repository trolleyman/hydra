//go:build !windows

package heads

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/nshost"
)

// TestRunPreExitInNamespace proves a pre_exit_script runs as a child of the head's
// supervisor — sharing its filesystem view — and that its output is captured.
// Bwrap-free: the supervisor's children share the test process's filesystem, which
// stands in for the shared bwrap overlay on a real host.
func TestRunPreExitInNamespace(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "control.sock")
	go func() { _ = nshost.Serve(sock) }()
	if err := nshost.WaitForSocket(sock, 2*time.Second); err != nil {
		t.Fatalf("supervisor never listened: %v", err)
	}

	host := &nsHost{id: "h1", client: nshost.Dial(sock), sockDir: dir}
	work := t.TempDir()
	marker := filepath.Join(work, "preexit.marker")

	out, err := runPreExitInNamespace(
		context.Background(), host, work, os.Environ(),
		"echo PREEXIT_OK; printf done > "+marker,
	)
	if err != nil {
		t.Fatalf("runPreExitInNamespace: %v", err)
	}
	if !strings.Contains(string(out), "PREEXIT_OK") {
		t.Errorf("expected hook output to contain PREEXIT_OK, got %q", out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("pre_exit_script did not write its marker (ran in the shared namespace?): %v", err)
	}
}

// TestRunPreExitInNamespaceTimeout verifies a hung hook is bounded by the context.
func TestRunPreExitInNamespaceTimeout(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "control.sock")
	go func() { _ = nshost.Serve(sock) }()
	if err := nshost.WaitForSocket(sock, 2*time.Second); err != nil {
		t.Fatalf("supervisor never listened: %v", err)
	}

	host := &nsHost{id: "h1", client: nshost.Dial(sock), sockDir: dir}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := runPreExitInNamespace(ctx, host, t.TempDir(), os.Environ(), "sleep 30")
	if err == nil {
		t.Fatal("expected a timeout error for a hung hook")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("timeout was not enforced promptly (took %s)", elapsed)
	}
}
