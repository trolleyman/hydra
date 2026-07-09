package session

import (
	"os"
	"sync"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// Status is the lifecycle state of a session.
type Status string

const (
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusExited   Status = "exited"
)

// defaultScrollback is the per-session scrollback ring capacity.
const defaultScrollback = 512 * 1024

// chatScrollback is the ring capacity for chat-kind sessions. Their byte
// stream is Claude stream-json JSONL (bulkier than VT100 scrollback), and the
// ring replay is what reconstructs the conversation for a freshly-attached
// chat client, so it gets more room.
const chatScrollback = 2 * 1024 * 1024

// Kind distinguishes what a session's byte stream carries.
type Kind string

const (
	// KindTerminal is a VT100 byte stream from a PTY (the default).
	KindTerminal Kind = "terminal"
	// KindChat is Claude stream-json JSONL from a pipes-backed chat-mode head.
	// Resize is a no-op for these sessions.
	KindChat Kind = "chat"
)

// PTY is the terminal-attached process backing a session. It is satisfied both
// by a locally-launched sandbox process (ptyProcess) and by a child spawned
// inside a shared namespace host whose master fd was passed back to the daemon
// (nshost.Spawned).
type PTY interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Close() error
	Resize(rows, cols uint16) error
	Wait() error
	Pid() int
	Signal(sig os.Signal) error
}

// attacherBuffer is the per-attacher output channel depth (chunks).
const attacherBuffer = 512

// Session is one running (or recently-exited) agent process attached to a PTY,
// owned by the daemon and fanned out to any number of attachers.
type Session struct {
	ID           string
	AgentType    sandbox.AgentType
	WorktreePath string
	StartedAt    time.Time
	// Kind says what the byte stream carries: VT100 terminal output (the
	// default) or stream-json JSONL for chat-mode heads.
	Kind Kind

	proc    PTY
	scroll  *ring
	cleanup func() // releases sandbox temp resources after exit

	// ringFilter (chat sessions only) keeps stream_event partial-delta lines
	// out of the scrollback ring: attachers still receive them live (token
	// streaming), but replaying partials is redundant with the complete events
	// and would wrap the ring several times faster. Guarded by mu, like the
	// ring it feeds.
	ringFilter *claudestream.RingFilter

	mu        sync.Mutex
	attachers map[*attacher]struct{}
	rows      uint16
	cols      uint16
	status    Status
	exitErr   error

	// ephemeral sessions (web bash shells) self-terminate shortly after their
	// last attacher leaves; reapTimer is the pending grace-period kill, cancelled
	// if a new attacher arrives (e.g. a terminal refresh reconnecting). Both are
	// guarded by mu.
	ephemeral bool
	reapTimer *time.Timer

	// stopRequested records that hydra itself asked this session to terminate
	// (kill/merge, the chat-mode toggle, daemon drain). Exit handlers use it to
	// tell a deliberate stop from a process dying on its own (a crash, an OOM
	// kill, an agent pkill-ing itself), which is what auto-restart acts on.
	// Guarded by mu.
	stopRequested bool
}

// shellReapGrace is how long an ephemeral session waits, attacher-less, before
// terminating itself. Generous enough to survive a browser reload, navigating
// away and back, or a transient disconnect - the shell (and its scrollback) is
// still there when you return - while a tab you actually closed and abandoned is
// eventually reaped. (Killing the head terminates its shells immediately,
// independent of this grace; see Registry.KillMatching.)
const shellReapGrace = 5 * time.Minute

// attacher receives a copy of the session's output stream.
type attacher struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

func (a *attacher) close() {
	a.once.Do(func() { close(a.done) })
}

// send delivers data to the attacher, dropping the oldest buffered chunk if the
// consumer is too slow. Terminal output is lossy-tolerant; this guarantees a
// stuck client never blocks the shared reader or other attachers.
func (a *attacher) send(data []byte) {
	select {
	case a.ch <- data:
		return
	default:
	}
	// Drop one old chunk, then try again (best-effort).
	select {
	case <-a.ch:
	default:
	}
	select {
	case a.ch <- data:
	default:
	}
}

// Attachment is a consumer handle returned by Registry.Attach.
type Attachment struct {
	// Output yields terminal output chunks (scrollback first, then live).
	Output <-chan []byte
	// Done is closed when the session exits.
	Done <-chan struct{}

	session  *Session
	attacher *attacher
}

// Close detaches the consumer. It does not affect the session or other clients.
func (a *Attachment) Close() {
	a.session.detach(a.attacher)
}

// Size returns the session's current PTY window size (rows, cols). An attaching
// client uses it to size its terminal to match before rendering the replayed
// scrollback: those bytes carry cursor moves and line wrapping computed for this
// width, so rendering them at any other width lands every move in the wrong cell.
func (a *Attachment) Size() (rows, cols uint16) {
	a.session.mu.Lock()
	defer a.session.mu.Unlock()
	return a.session.rows, a.session.cols
}

// readLoop copies PTY output into the scrollback ring and every attacher until
// the process exits, then reaps it and invokes onExit.
func (s *Session) readLoop(onExit func(*Session)) {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.proc.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			s.mu.Lock()
			if s.ringFilter != nil {
				if kept := s.ringFilter.Filter(data); len(kept) > 0 {
					s.scroll.Write(kept)
				}
			} else {
				s.scroll.Write(data)
			}
			for a := range s.attachers {
				a.send(data)
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}

	werr := s.proc.Wait()

	s.mu.Lock()
	s.status = StatusExited
	s.exitErr = werr
	for a := range s.attachers {
		a.close()
	}
	s.mu.Unlock()

	if s.cleanup != nil {
		s.cleanup()
	}
	onExit(s)
}

// detach removes an attacher. For an ephemeral session whose last attacher just
// left, it schedules a grace-period self-termination (cancelled if someone
// reattaches first) so a closed shell tab doesn't leak a live process.
func (s *Session) detach(a *attacher) {
	s.mu.Lock()
	delete(s.attachers, a)
	if s.ephemeral && len(s.attachers) == 0 && s.status != StatusExited && s.reapTimer == nil {
		s.reapTimer = time.AfterFunc(shellReapGrace, func() {
			s.mu.Lock()
			idle := len(s.attachers) == 0 && s.status != StatusExited
			s.mu.Unlock()
			if idle {
				s.stop()
			}
		})
	}
	s.mu.Unlock()
	a.close()
}

// attach registers a new consumer, replaying current scrollback first.
func (s *Session) attach(rows, cols uint16) *Attachment {
	a := &attacher{
		ch:   make(chan []byte, attacherBuffer),
		done: make(chan struct{}),
	}

	s.mu.Lock()
	snapshot := s.scroll.Bytes()
	if s.ringFilter != nil {
		// The filter only persists COMPLETE lines; the head of the in-flight
		// line is buffered in the filter, not the ring. The live stream this
		// attacher is about to receive continues from the reader's current
		// mid-line position, so append the buffered head or the seam would
		// corrupt the attacher's first line.
		if pending := s.ringFilter.Pending(); len(pending) > 0 {
			snapshot = append(append(make([]byte, 0, len(snapshot)+len(pending)), snapshot...), pending...)
		}
	}
	exited := s.status == StatusExited
	if !exited {
		s.attachers[a] = struct{}{}
		// A new attacher cancels any pending ephemeral reap (e.g. a refresh
		// reconnecting before the grace period elapsed).
		if s.reapTimer != nil {
			s.reapTimer.Stop()
			s.reapTimer = nil
		}
		// Adopt the newest requested size.
		if rows > 0 && cols > 0 {
			s.rows, s.cols = rows, cols
		}
	}
	s.mu.Unlock()

	if len(snapshot) > 0 {
		a.ch <- snapshot
	}
	if exited {
		a.close()
	} else if rows > 0 && cols > 0 {
		_ = s.proc.Resize(rows, cols)
	}

	return &Attachment{Output: a.ch, Done: a.done, session: s, attacher: a}
}

// write sends bytes to the PTY (agent stdin).
func (s *Session) write(data []byte) error {
	_, err := s.proc.Write(data)
	return err //errtrace:skip
}

// resize updates the PTY window size (most-recent-wins).
func (s *Session) resize(rows, cols uint16) error {
	s.mu.Lock()
	s.rows, s.cols = rows, cols
	s.mu.Unlock()
	return errtrace.Wrap(s.proc.Resize(rows, cols))
}

// stop signals the process to terminate; the readLoop handles cleanup.
func (s *Session) stop() {
	s.markStopRequested()
	_ = s.proc.Signal(syscall.SIGTERM)
}

// kill forcibly terminates the process.
func (s *Session) kill() {
	s.markStopRequested()
	_ = s.proc.Signal(os.Kill)
}

func (s *Session) markStopRequested() {
	s.mu.Lock()
	s.stopRequested = true
	s.mu.Unlock()
}

// Info is a point-in-time snapshot of a session's state.
type Info struct {
	ID        string
	AgentType sandbox.AgentType
	PID       int
	Status    Status
	StartedAt time.Time
	Ephemeral bool
	// StopRequested is true when hydra itself terminated the session (kill,
	// mode toggle, drain) - as opposed to the process dying on its own.
	StopRequested bool
}

// PID returns the sandbox process PID (0 if not started).
func (s *Session) PID() int {
	return s.proc.Pid()
}

// alive reports whether the underlying OS process is still running, via a
// signal-0 probe (side-effect-free; it only checks existence/permission).
func (s *Session) alive() bool {
	return s.proc.Signal(syscall.Signal(0)) == nil
}

// reapIfDead forces the session into the exited state when its process has
// already died but the read loop never observed the PTY close - which would
// otherwise pin the session "live" forever (IsLive true), blocking resume and
// keeping the head's status stuck at "running". Returns true if it reaped.
//
// Idempotent: an already-exited session, or one whose process is still alive,
// returns false and is left untouched. It best-effort closes the PTY to wake any
// still-blocked read loop, which then runs the normal cleanup/onExit path; the
// status flip here guarantees liveness flips even if that read never unblocks.
func (s *Session) reapIfDead() bool {
	s.mu.Lock()
	if s.status == StatusExited || s.alive() {
		s.mu.Unlock()
		return false
	}
	s.status = StatusExited
	for a := range s.attachers {
		a.close()
	}
	s.mu.Unlock()

	_ = s.proc.Close()
	return true
}

func (s *Session) info() Info {
	s.mu.Lock()
	status := s.status
	stopRequested := s.stopRequested
	s.mu.Unlock()
	return Info{
		ID:            s.ID,
		AgentType:     s.AgentType,
		PID:           s.proc.Pid(),
		Status:        status,
		StartedAt:     s.StartedAt,
		Ephemeral:     s.ephemeral,
		StopRequested: stopRequested,
	}
}
