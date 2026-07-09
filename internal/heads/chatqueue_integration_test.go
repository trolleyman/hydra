package heads

import (
	"bytes"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// capturePTY is a session.PTY that records everything written to the child's
// stdin (so a drained message can be asserted) and lets a test feed bytes to
// the read side (so a `result` line can be pushed through the real session read
// loop). It never exits until Close.
type capturePTY struct {
	mu     sync.Mutex
	writes [][]byte
	readCh chan []byte
	closed chan struct{}
	once   sync.Once
}

func newCapturePTY() *capturePTY {
	return &capturePTY{readCh: make(chan []byte, 8), closed: make(chan struct{})}
}

func (p *capturePTY) Read(b []byte) (int, error) {
	select {
	case data := <-p.readCh:
		return copy(b, data), nil
	case <-p.closed:
		return 0, errtrace.Wrap(io.EOF)
	}
}

func (p *capturePTY) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, append([]byte(nil), b...))
	return len(b), nil
}

func (p *capturePTY) Close() error {
	p.once.Do(func() { close(p.closed) })
	return nil
}
func (p *capturePTY) Resize(uint16, uint16) error { return nil }
func (p *capturePTY) Wait() error                 { <-p.closed; return nil }
func (p *capturePTY) Pid() int                    { return 4242 }
func (p *capturePTY) Signal(os.Signal) error      { return nil }

// feed pushes one output chunk to the read loop (as if the CLI printed it).
func (p *capturePTY) feed(data []byte) { p.readCh <- data }

func (p *capturePTY) written() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return string(bytes.Join(p.writes, nil))
}

// managerFixture wires a real registry + chat session + DB agent around a
// ChatQueueManager, so the manager's stdin writes land on capturePTY.
func managerFixture(t *testing.T) (*ChatQueueManager, *capturePTY, string) {
	t.Helper()
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.CreateAgent(&db.Agent{ID: "agent-x", ProjectPath: root, AgentType: "claude"}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	reg := session.NewRegistry()
	pty := newCapturePTY()
	if _, err := reg.StartWithProc("agent-x", sandbox.AgentTypeClaude, root, 24, 80, false, session.KindChat, pty); err != nil {
		t.Fatalf("start session: %v", err)
	}
	t.Cleanup(func() { _ = pty.Close() })
	return NewChatQueueManager(reg, store), pty, root
}

func waitUntil(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(msg)
}

// An idle send goes straight to stdin; queued sends are held and drain one per
// turn end, in order, writing to the session's stdin.
func TestChatQueueManagerDrainsToStdin(t *testing.T) {
	mgr, pty, root := managerFixture(t)

	mgr.Submit(root, "agent-x", msg("a", "FIRST"), false)
	mgr.Submit(root, "agent-x", msg("b", "SECOND"), true)
	mgr.Submit(root, "agent-x", msg("c", "THIRD"), true)

	if w := pty.written(); !strings.Contains(w, "FIRST") {
		t.Fatalf("idle send not written to stdin: %q", w)
	}
	if strings.Contains(pty.written(), "SECOND") {
		t.Fatal("a queued message was written before its turn")
	}

	mgr.OnTurnEnd("agent-x") // drains SECOND
	mgr.OnTurnEnd("agent-x") // drains THIRD
	w := pty.written()
	iF, iS, iT := strings.Index(w, "FIRST"), strings.Index(w, "SECOND"), strings.Index(w, "THIRD")
	if iS < 0 || iT < 0 {
		t.Fatalf("queued drains missing from stdin: %q", w)
	}
	if !(iF < iS && iS < iT) {
		t.Fatalf("drain order wrong: FIRST@%d SECOND@%d THIRD@%d", iF, iS, iT)
	}

	before := len(pty.written())
	mgr.OnTurnEnd("agent-x") // nothing left
	if len(pty.written()) != before {
		t.Fatal("draining an empty queue wrote to stdin")
	}
}

// A dequeued (recalled) message is dropped and never sent.
func TestChatQueueManagerDequeueThenTurnEnd(t *testing.T) {
	mgr, pty, root := managerFixture(t)
	mgr.Submit(root, "agent-x", msg("b", "RECALLED"), true)
	if !mgr.Dequeue(root, "agent-x", "b") {
		t.Fatal("dequeue of a queued message should succeed")
	}
	mgr.OnTurnEnd("agent-x")
	if strings.Contains(pty.written(), "RECALLED") {
		t.Fatalf("a dequeued message was still sent: %q", pty.written())
	}
}

// On attach, a queue left over while the head is idle (e.g. restored from disk)
// is kicked; a running/starting head is left for its normal turn-end drain.
func TestChatQueueManagerOnAttach(t *testing.T) {
	mgr, pty, root := managerFixture(t)

	// Idle (finished): draining on attach.
	mgr.queue(root, "agent-x").Enqueue(msg("d", "DELAYED"))
	if err := WriteAgentStatus(root, "agent-x", &api.AgentStatusInfo{Status: api.Finished, Timestamp: "2025-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	mgr.OnAttach(root, "agent-x")
	if !strings.Contains(pty.written(), "DELAYED") {
		t.Fatalf("idle attach did not drain the queue: %q", pty.written())
	}

	// Running: NOT drained on attach.
	mgr.queue(root, "agent-x").Enqueue(msg("e", "HELDRUNNING"))
	if err := WriteAgentStatus(root, "agent-x", &api.AgentStatusInfo{Status: api.Running, Timestamp: "2025-01-01T00:00:01Z"}); err != nil {
		t.Fatal(err)
	}
	mgr.OnAttach(root, "agent-x")
	if strings.Contains(pty.written(), "HELDRUNNING") {
		t.Fatalf("attach drained a running head's queue: %q", pty.written())
	}
}

// End to end (daemon side, minus the real CLI): a `result` line on the chat
// session's stdout fires the registry's OnChatResult hook, which drains the
// next queued message to stdin.
func TestChatResultDrainsViaRegistry(t *testing.T) {
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.CreateAgent(&db.Agent{ID: "agent-x", ProjectPath: root, AgentType: "claude"}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	reg := session.NewRegistry()
	pty := newCapturePTY()
	if _, err := reg.StartWithProc("agent-x", sandbox.AgentTypeClaude, root, 24, 80, false, session.KindChat, pty); err != nil {
		t.Fatalf("start session: %v", err)
	}
	t.Cleanup(func() { _ = pty.Close() })

	mgr := NewChatQueueManager(reg, store)
	reg.SetOnChatResult(mgr.OnTurnEnd)
	mgr.Submit(root, "agent-x", msg("b", "DRAINME"), true)

	// The CLI prints a result line at turn end; the session read loop feeds it
	// through the RingFilter, which fires the (async) drain.
	pty.feed([]byte(`{"type":"result","subtype":"success","duration_ms":10}` + "\n"))
	waitUntil(t, func() bool { return strings.Contains(pty.written(), "DRAINME") },
		"result line did not drain the queued message to stdin")
}

// A user interrupt ends the turn with a `result` line (subtype
// error_during_execution) but fires NO Stop hook (spike-verified against the
// real CLI), so the daemon itself must flip the head out of "running". End to
// end minus the CLI: mark the interrupt (as the chat WS handler does), feed the
// CLI's actual post-interrupt output, and expect the status written as
// "waiting" plus the queued message drained to stdin.
func TestChatInterruptWritesWaitingStatusAndDrains(t *testing.T) {
	mgr, pty, root := managerFixture(t)
	reg := mgr.reg
	reg.SetOnChatResult(mgr.OnTurnEnd)

	// Mid-turn state: the hook marked the head running, and a message is queued.
	if err := WriteAgentStatus(root, "agent-x", &api.AgentStatusInfo{Status: api.Running, Timestamp: "2025-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	mgr.Submit(root, "agent-x", msg("q", "AFTER-INTERRUPT"), true)

	mgr.MarkInterrupted("agent-x")
	// What the CLI actually prints when interrupted (in this order).
	pty.feed([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}` + "\n"))
	pty.feed([]byte(`{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":7330}` + "\n"))

	waitUntil(t, func() bool {
		s := ReadAgentStatus(root, "agent-x")
		return s != nil && s.Status == api.Waiting
	}, "interrupted turn end did not write the waiting status")
	waitUntil(t, func() bool { return strings.Contains(pty.written(), "AFTER-INTERRUPT") },
		"interrupted turn end did not drain the queued message")
}

// A normal (un-interrupted) turn end must not touch the status file - that is
// the Stop hook's job - and a stale interrupt mark (one whose turn never
// answered, superseded by a later user send) must not relabel a later turn.
func TestChatTurnEndWithoutInterruptLeavesStatus(t *testing.T) {
	mgr, pty, root := managerFixture(t)

	if err := WriteAgentStatus(root, "agent-x", &api.AgentStatusInfo{Status: api.Running, Timestamp: "2025-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}

	// Plain turn end: no mark, no status write.
	mgr.OnTurnEnd("agent-x")
	if s := ReadAgentStatus(root, "agent-x"); s == nil || s.Status != api.Running {
		t.Fatalf("un-interrupted turn end rewrote the status: %+v", s)
	}

	// A mark followed by a new user send is stale: the send starts a fresh turn
	// whose end is a normal one.
	mgr.MarkInterrupted("agent-x")
	mgr.Submit(root, "agent-x", msg("d", "DIRECT"), false)
	if !strings.Contains(pty.written(), "DIRECT") {
		t.Fatalf("direct send not written to stdin: %q", pty.written())
	}
	mgr.OnTurnEnd("agent-x")
	if s := ReadAgentStatus(root, "agent-x"); s == nil || s.Status != api.Running {
		t.Fatalf("stale interrupt mark relabeled a later turn end: %+v", s)
	}

	// An expired mark (interrupt that never produced a turn end) is discarded.
	mgr.MarkInterrupted("agent-x")
	mgr.mu.Lock()
	mgr.interrupted["agent-x"] = time.Now().Add(-2 * interruptMarkTTL)
	mgr.mu.Unlock()
	mgr.OnTurnEnd("agent-x")
	if s := ReadAgentStatus(root, "agent-x"); s == nil || s.Status != api.Running {
		t.Fatalf("expired interrupt mark relabeled a later turn end: %+v", s)
	}
}
