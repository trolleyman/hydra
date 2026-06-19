//go:build !windows

package heads

import (
	"context"
	"os"
	"os/exec"
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

// registerStubHost inserts a ready registry slot whose "supervisor" is the given
// process, with a watcher running, and returns a channel closed when its cleanup
// runs. Used to exercise the eviction/teardown logic without bwrap.
func registerStubHost(t *testing.T, id string, proc *exec.Cmd) chan struct{} {
	t.Helper()
	if err := proc.Start(); err != nil {
		t.Fatalf("start stub supervisor: %v", err)
	}
	cleaned := make(chan struct{})
	h := &nsHost{id: id, proc: proc, sockDir: t.TempDir(), cleanup: func() { close(cleaned) }, done: make(chan struct{})}
	e := &nsHostEntry{ready: make(chan struct{}), host: h}
	close(e.ready)
	nsHosts.mu.Lock()
	nsHosts.m[id] = e
	nsHosts.mu.Unlock()
	go watchNamespaceHost(id, h, e)
	return cleaned
}

// TestRemoveNamespaceHostSynchronous verifies removeNamespaceHost kills the
// supervisor, waits for the watcher to reclaim resources, and evicts the slot —
// all before it returns.
func TestRemoveNamespaceHostSynchronous(t *testing.T) {
	const id = "ns-remove-test"
	cleaned := registerStubHost(t, id, exec.Command("sleep", "30"))

	if _, ok := namespaceHostFor(id); !ok {
		t.Fatal("host should be present before removal")
	}

	removeNamespaceHost(id)

	select {
	case <-cleaned:
	default:
		t.Error("cleanup should have run before removeNamespaceHost returned")
	}
	if _, ok := namespaceHostFor(id); ok {
		t.Error("host should be evicted after removeNamespaceHost")
	}
}

// TestNamespaceHostEvictedOnExit verifies the watcher evicts a supervisor that
// exits on its own (a crash), so a later lookup re-creates a fresh one.
func TestNamespaceHostEvictedOnExit(t *testing.T) {
	const id = "ns-crash-test"
	registerStubHost(t, id, exec.Command("sleep", "0.1"))

	deadline := time.After(5 * time.Second)
	for {
		if _, ok := namespaceHostFor(id); !ok {
			return // evicted as expected
		}
		select {
		case <-deadline:
			t.Fatal("supervisor exit did not evict the registry slot")
		case <-time.After(20 * time.Millisecond):
		}
	}
}
