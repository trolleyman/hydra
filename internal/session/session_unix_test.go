//go:build !windows

package session

import (
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/sandbox"
)

// newTestSession wires a Session around a hand-built spec, bypassing
// sandbox.BuildSpec so the PTY plumbing can be tested without bubblewrap (which
// needs unprivileged user namespaces unavailable in CI/nested sandboxes).
func newTestSession(t *testing.T, argv ...string) (*Session, func()) {
	t.Helper()
	spec := &sandbox.Spec{Path: argv[0], Args: argv, Cleanup: func() {}}
	proc, err := startProcess(spec, 24, 80)
	if err != nil {
		t.Fatalf("startProcess: %v", err)
	}
	s := &Session{
		ID:        "test",
		proc:      proc,
		scroll:    newRing(defaultScrollback),
		cleanup:   spec.Cleanup,
		attachers: make(map[*attacher]struct{}),
		status:    StatusRunning,
	}
	done := make(chan struct{})
	go s.readLoop(func(*Session) { close(done) })
	return s, func() {
		s.kill()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}

func TestSessionOutputAndScrollback(t *testing.T) {
	s, cleanup := newTestSession(t, "/bin/sh", "-c", "echo hydra-marker; sleep 1")
	defer cleanup()

	// Attach and collect output for a moment.
	att := s.attach(24, 80)
	defer att.Close()

	got := collect(att, 1500*time.Millisecond)
	if !strings.Contains(got, "hydra-marker") {
		t.Errorf("live output missing marker; got %q", got)
	}

	// A second attacher should receive the scrollback replay.
	att2 := s.attach(24, 80)
	defer att2.Close()
	got2 := collect(att2, 500*time.Millisecond)
	if !strings.Contains(got2, "hydra-marker") {
		t.Errorf("scrollback replay missing marker; got %q", got2)
	}
}

func TestSessionStdin(t *testing.T) {
	// cat echoes stdin back to the PTY.
	s, cleanup := newTestSession(t, "/bin/cat")
	defer cleanup()
	att := s.attach(24, 80)
	defer att.Close()

	if err := s.write([]byte("ping-pong\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := collect(att, 1*time.Second)
	if !strings.Contains(got, "ping-pong") {
		t.Errorf("stdin not echoed; got %q", got)
	}
}

func TestSessionExitClosesAttachers(t *testing.T) {
	s, cleanup := newTestSession(t, "/bin/sh", "-c", "exit 0")
	defer cleanup()
	att := s.attach(24, 80)
	defer att.Close()
	select {
	case <-att.Done:
		// expected
	case <-time.After(2 * time.Second):
		t.Error("attacher Done not closed after process exit")
	}
}

func collect(att *Attachment, d time.Duration) string {
	var sb strings.Builder
	deadline := time.After(d)
	for {
		select {
		case b, ok := <-att.Output:
			if !ok {
				return sb.String()
			}
			sb.Write(b)
		case <-att.Done:
			// drain any remaining buffered output
			for {
				select {
				case b := <-att.Output:
					sb.Write(b)
				default:
					return sb.String()
				}
			}
		case <-deadline:
			return sb.String()
		}
	}
}
