package heads

import (
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

func TestShouldNudgeResumedAgent(t *testing.T) {
	cases := map[string]bool{
		"running":  true,
		"waiting":  false,
		"finished": false,
		"starting": false,
		"stopped":  false,
		"":         false,
	}
	for status, want := range cases {
		if got := shouldNudgeResumedAgent(status); got != want {
			t.Errorf("shouldNudgeResumedAgent(%q) = %v, want %v", status, got, want)
		}
	}
}

// fakePTY is a minimal session.PTY: it emits one initial burst, then stays
// silent (Read blocks) until closed, and records everything written to it.
type fakePTY struct {
	initial     []byte
	mu          sync.Mutex
	buf         []byte
	sentInitial bool
	closed      chan struct{}
	once        sync.Once
}

func newFakePTY(initial []byte) *fakePTY {
	return &fakePTY{initial: initial, closed: make(chan struct{})}
}

func (p *fakePTY) Read(b []byte) (int, error) {
	p.mu.Lock()
	if !p.sentInitial {
		p.sentInitial = true
		n := copy(b, p.initial)
		p.mu.Unlock()
		return n, nil
	}
	p.mu.Unlock()
	<-p.closed
	return 0, errtrace.Wrap(io.EOF)
}

func (p *fakePTY) Write(b []byte) (int, error) {
	p.mu.Lock()
	p.buf = append(p.buf, b...)
	p.mu.Unlock()
	return len(b), nil
}

func (p *fakePTY) written() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return string(p.buf)
}

func (p *fakePTY) shut() { p.once.Do(func() { close(p.closed) }) }

func (p *fakePTY) Close() error                   { p.shut(); return nil }
func (p *fakePTY) Resize(rows, cols uint16) error { return nil }
func (p *fakePTY) Wait() error                    { <-p.closed; return nil }
func (p *fakePTY) Pid() int                       { return 4321 }
func (p *fakePTY) Signal(os.Signal) error         { p.shut(); return nil }

func TestNudgeResumedAgentTypesMessageAndEnter(t *testing.T) {
	reg := session.NewRegistry()
	pty := newFakePTY([]byte("Resuming previous conversation...\n"))
	if _, err := reg.StartWithProc("agent1", sandbox.AgentTypeClaude, t.TempDir(), 24, 80, false, session.KindTerminal, pty); err != nil {
		t.Fatalf("StartWithProc: %v", err)
	}
	defer reg.Kill("agent1")

	timing := resumeNudgeTiming{
		minDelay:   30 * time.Millisecond,
		quietFor:   30 * time.Millisecond,
		maxWait:    2 * time.Second,
		enterDelay: 10 * time.Millisecond,
		poll:       5 * time.Millisecond,
	}
	nudgeResumedAgentWith(reg, "agent1", "Continue", timing)

	if got := pty.written(); got != "Continue\r" {
		t.Errorf("nudge wrote %q, want %q", got, "Continue\r")
	}
}

func TestNudgeResumedAgentAbortsWhenSessionDies(t *testing.T) {
	reg := session.NewRegistry()
	pty := newFakePTY(nil)
	if _, err := reg.StartWithProc("agent2", sandbox.AgentTypeClaude, t.TempDir(), 24, 80, false, session.KindTerminal, pty); err != nil {
		t.Fatalf("StartWithProc: %v", err)
	}

	// Kill the session shortly after the nudge starts waiting; it must give up
	// without writing anything.
	go func() {
		time.Sleep(20 * time.Millisecond)
		_ = reg.Kill("agent2")
	}()

	timing := resumeNudgeTiming{
		minDelay:   500 * time.Millisecond,
		quietFor:   500 * time.Millisecond,
		maxWait:    5 * time.Second,
		enterDelay: 10 * time.Millisecond,
		poll:       5 * time.Millisecond,
	}
	nudgeResumedAgentWith(reg, "agent2", "Continue", timing)

	if got := pty.written(); got != "" {
		t.Errorf("dead session was nudged: wrote %q", got)
	}
}
