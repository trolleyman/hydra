//go:build !windows

package session

import (
	"errors"
	"io"
	"os"
	"sync"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

// fakePTY is a controllable PTY whose process liveness is fixed at construction.
// Read blocks until Close, modelling the stuck-running bug: a process that has
// died but whose PTY never reports EOF, so the read loop never reaps it.
type fakePTY struct {
	mu     sync.Mutex
	alive  bool
	closed chan struct{}
}

func newFakePTY(alive bool) *fakePTY { return &fakePTY{alive: alive, closed: make(chan struct{})} }

func (f *fakePTY) Read(p []byte) (int, error) { <-f.closed; return 0, io.EOF }
func (f *fakePTY) Write(p []byte) (int, error) { return len(p), nil }
func (f *fakePTY) Resize(uint16, uint16) error { return nil }
func (f *fakePTY) Wait() error                 { <-f.closed; return nil }
func (f *fakePTY) Pid() int                    { return 4242 }

func (f *fakePTY) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.closed:
	default:
		close(f.closed)
	}
	return nil
}

func (f *fakePTY) Signal(os.Signal) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.alive {
		return nil
	}
	return errors.New("os: process already finished")
}

// TestReapDeadStuckSession covers the core of the stuck-running fix: a session
// whose process has died but whose read loop is still blocked (PTY never EOF'd)
// appears live, which pins the head at "running". ReapDead must detect the dead
// process, force the session exited, and flip IsLive/Snapshot so the reconciler
// and lazy resume treat it as gone.
func TestReapDeadStuckSession(t *testing.T) {
	r := NewRegistry()
	r.register("stuck", sandbox.AgentTypeClaude, "/wt", 24, 80, false, newFakePTY(false), func() {})

	if !r.IsLive("stuck") {
		t.Fatal("precondition: a freshly registered session should be live")
	}

	if !r.ReapDead("stuck") {
		t.Fatal("ReapDead = false, want true for a dead process")
	}
	if r.IsLive("stuck") {
		t.Error("IsLive still true after reaping a dead session")
	}

	// Snapshot must report it exited, so the liveness reconciler classifies it as
	// gone (its first branch requires running/starting) and marks it stopped.
	var found bool
	for _, info := range r.Snapshot() {
		if info.ID == "stuck" {
			found = true
			if info.Status != StatusExited {
				t.Errorf("Snapshot status = %q, want exited", info.Status)
			}
		}
	}
	if !found {
		t.Error("reaped session missing from Snapshot")
	}

	// Idempotent: an already-exited session is not reaped again.
	if r.ReapDead("stuck") {
		t.Error("second ReapDead = true, want false (already exited)")
	}
}

// TestReapDeadLeavesLiveSession ensures a healthy session is never reaped.
func TestReapDeadLeavesLiveSession(t *testing.T) {
	r := NewRegistry()
	pty := newFakePTY(true)
	r.register("alive", sandbox.AgentTypeClaude, "/wt", 24, 80, false, pty, func() {})
	t.Cleanup(func() { _ = pty.Close() })

	if r.ReapDead("alive") {
		t.Error("ReapDead reaped a live session")
	}
	if !r.IsLive("alive") {
		t.Error("live session no longer live after a no-op ReapDead")
	}
}

// TestReapDeadUnknownSession is a no-op for an unknown id.
func TestReapDeadUnknownSession(t *testing.T) {
	r := NewRegistry()
	if r.ReapDead("nope") {
		t.Error("ReapDead on unknown id = true, want false")
	}
}
