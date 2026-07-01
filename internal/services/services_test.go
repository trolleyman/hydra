package services

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/config"
)

// writeProjectConfig writes a .hydra/config.toml holding the given body into a
// fresh temp dir and returns the dir (a usable project root for the manager).
func writeProjectConfig(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := config.GetProjectConfigPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fastManager returns a Manager with tiny timing knobs for tests.
func fastManager() *Manager {
	m := NewManager()
	m.initialBackoff = 5 * time.Millisecond
	m.maxBackoff = 10 * time.Millisecond
	m.stableThreshold = time.Hour // never reset the counter during the test
	m.stopGrace = 100 * time.Millisecond
	return m
}

func waitForState(t *testing.T, m *Manager, root, name string, want State, timeout time.Duration) Status {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, s := range m.Status(root) {
			if s.Name == name && s.State == want {
				return s
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("service %q did not reach state %q within %s; status=%+v", name, want, timeout, m.Status(root))
	return Status{}
}

// TestServiceRestartBudget checks a service that keeps exiting is restarted up
// to its budget and then marked failed.
func TestServiceRestartBudget(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "boom"
command = "exit 1"
host = true
max_restarts = 2
`)
	m := fastManager()
	m.StartProject(root)
	defer m.StopProject(root)

	s := waitForState(t, m, root, "boom", StateFailed, 3*time.Second)
	if s.Restarts != 2 {
		t.Fatalf("expected 2 restarts before failing, got %d (%+v)", s.Restarts, s)
	}
	if s.MaxRestarts != 2 {
		t.Fatalf("expected MaxRestarts 2, got %d", s.MaxRestarts)
	}
}

// TestServiceStop checks a long-running service is torn down promptly on stop.
func TestServiceStop(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "sleeper"
command = "sleep 60"
host = true
`)
	m := fastManager()
	m.StartProject(root)

	waitForState(t, m, root, "sleeper", StateRunning, 3*time.Second)

	start := time.Now()
	m.StopProject(root)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("StopProject took too long: %s", elapsed)
	}
	if got := m.Status(root); got != nil {
		t.Fatalf("expected no status after stop, got %+v", got)
	}
}

// TestServiceNeverRestart checks max_restarts = 0 fails on the first exit.
func TestServiceNeverRestart(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "once"
command = "exit 3"
host = true
max_restarts = 0
`)
	m := fastManager()
	m.StartProject(root)
	defer m.StopProject(root)

	s := waitForState(t, m, root, "once", StateFailed, 3*time.Second)
	if s.Restarts != 0 {
		t.Fatalf("expected 0 restarts, got %d", s.Restarts)
	}
}

// counter is a tiny concurrency-safe agent-count source for the gate tests.
type counter struct {
	mu sync.Mutex
	n  int
}

func (c *counter) set(n int) { c.mu.Lock(); c.n = n; c.mu.Unlock() }
func (c *counter) get() int  { c.mu.Lock(); defer c.mu.Unlock(); return c.n }

// TestActivityGateBootsPausedWithoutAgents checks that, with an activity probe
// reporting no agents, StartProject registers the project paused rather than
// launching its services.
func TestActivityGateBootsPausedWithoutAgents(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "sleeper"
command = "sleep 60"
host = true
`)
	m := fastManager()
	agents := &counter{}
	m.SetActivityProbe(func(string) int { return agents.get() })

	m.StartProject(root)
	defer m.StopProject(root)

	s := waitForState(t, m, root, "sleeper", StatePaused, time.Second)
	if s.PID != 0 {
		t.Fatalf("paused service should have no PID, got %d", s.PID)
	}
}

// TestActivityGatePausesAndResumes checks the reconciler starts a paused
// project's services when an agent appears and pauses them again once the
// project has been idle past the timeout.
func TestActivityGatePausesAndResumes(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "sleeper"
command = "sleep 60"
host = true
`)
	m := fastManager()
	m.idleTimeout = 20 * time.Millisecond
	m.gateInterval = 5 * time.Millisecond
	agents := &counter{}
	m.SetActivityProbe(func(string) int { return agents.get() })

	m.StartProject(root)
	defer m.StopProject(root)
	waitForState(t, m, root, "sleeper", StatePaused, time.Second)

	go m.RunActivityGate(t.Context())

	// An agent appears → the gate launches the services.
	agents.set(1)
	waitForState(t, m, root, "sleeper", StateRunning, 2*time.Second)

	// The agent goes away → after the idle timeout the services pause again.
	agents.set(0)
	waitForState(t, m, root, "sleeper", StatePaused, 2*time.Second)
}

// TestActivityGateStartsRunningWithAgents checks a project that already has an
// agent at registration launches its services immediately (not paused).
func TestActivityGateStartsRunningWithAgents(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "sleeper"
command = "sleep 60"
host = true
`)
	m := fastManager()
	agents := &counter{n: 1}
	m.SetActivityProbe(func(string) int { return agents.get() })

	m.StartProject(root)
	defer m.StopProject(root)

	waitForState(t, m, root, "sleeper", StateRunning, 2*time.Second)
}

// TestStartProjectIdempotent checks a second StartProject is a no-op (does not
// double-launch).
func TestStartProjectIdempotent(t *testing.T) {
	root := writeProjectConfig(t, `[[services]]
name = "sleeper"
command = "sleep 60"
host = true
`)
	m := fastManager()
	m.StartProject(root)
	defer m.StopProject(root)
	waitForState(t, m, root, "sleeper", StateRunning, 3*time.Second)

	m.StartProject(root) // no-op
	if got := m.Status(root); len(got) != 1 {
		t.Fatalf("expected 1 service after idempotent start, got %d", len(got))
	}
}
