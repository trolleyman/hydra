package heads

import (
	"fmt"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/session"
)

// stubbornPTY models an agent that ignores SIGTERM: only SIGKILL ends it. The
// eofOnKill knob picks how death is observed - true closes the PTY so the read
// loop sees EOF (the normal case), false leaves the read blocked forever so
// only liveness probes (signal 0) can tell (the ReapDead case).
type stubbornPTY struct {
	mu        sync.Mutex
	dead      bool
	eofOnKill bool
	closed    chan struct{}
}

func newStubbornPTY(eofOnKill bool) *stubbornPTY {
	return &stubbornPTY{eofOnKill: eofOnKill, closed: make(chan struct{})}
}

func (f *stubbornPTY) Read(p []byte) (int, error)  { <-f.closed; return 0, errtrace.Wrap(io.EOF) }
func (f *stubbornPTY) Write(p []byte) (int, error) { return len(p), nil }
func (f *stubbornPTY) Resize(uint16, uint16) error { return nil }
func (f *stubbornPTY) Wait() error                 { <-f.closed; return nil }
func (f *stubbornPTY) Pid() int                    { return 4243 }

func (f *stubbornPTY) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.closed:
	default:
		close(f.closed)
	}
	return nil
}

func (f *stubbornPTY) Signal(sig os.Signal) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if sig == os.Kill {
		f.dead = true
		if f.eofOnKill {
			select {
			case <-f.closed:
			default:
				close(f.closed)
			}
		}
		return nil
	}
	// Signal 0 is the liveness probe; anything else (SIGTERM) is ignored.
	if f.dead {
		return errtrace.Wrap(fmt.Errorf("process already finished"))
	}
	return nil
}

// TestStopSessionAndWaitStubborn covers the chat/terminal mode-toggle teardown
// against a SIGTERM-ignoring session: StopSessionAndWait must not return while
// the corpse is still registered live, or the client reconnecting on the API
// response attaches to it instead of hitting the on-attach lazy resume.
func TestStopSessionAndWaitStubborn(t *testing.T) {
	for _, tc := range []struct {
		name      string
		eofOnKill bool
	}{
		{"kill-reports-eof", true},
		// The PTY never EOFs after the SIGKILL; ReapDead is the backstop.
		{"kill-never-eofs", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reg := session.NewRegistry()
			pty := newStubbornPTY(tc.eofOnKill)
			if _, err := reg.StartWithProc("stubborn", "claude", t.TempDir(), 24, 80, false, session.KindTerminal, pty); err != nil {
				t.Fatalf("StartWithProc: %v", err)
			}
			if !reg.IsLive("stubborn") {
				t.Fatal("session should start live")
			}

			done := make(chan struct{})
			go func() {
				StopSessionAndWait(reg, "stubborn", 300*time.Millisecond)
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("StopSessionAndWait did not return")
			}
			if reg.IsLive("stubborn") {
				t.Fatal("session still live after StopSessionAndWait returned")
			}
		})
	}
}
