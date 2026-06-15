package session

import (
	"os"
	"sync"
	"syscall"
	"time"

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

// attacherBuffer is the per-attacher output channel depth (chunks).
const attacherBuffer = 512

// Session is one running (or recently-exited) agent process attached to a PTY,
// owned by the daemon and fanned out to any number of attachers.
type Session struct {
	ID           string
	AgentType    sandbox.AgentType
	WorktreePath string
	StartedAt    time.Time

	proc    *ptyProcess
	scroll  *ring
	cleanup func() // releases sandbox temp resources after exit

	mu        sync.Mutex
	attachers map[*attacher]struct{}
	rows      uint16
	cols      uint16
	status    Status
	exitErr   error
}

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
			s.scroll.Write(data)
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

// detach removes an attacher.
func (s *Session) detach(a *attacher) {
	s.mu.Lock()
	delete(s.attachers, a)
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
	exited := s.status == StatusExited
	if !exited {
		s.attachers[a] = struct{}{}
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
	return s.proc.Resize(rows, cols)
}

// stop signals the process to terminate; the readLoop handles cleanup.
func (s *Session) stop() {
	_ = s.proc.Signal(syscall.SIGTERM)
}

// kill forcibly terminates the process.
func (s *Session) kill() {
	_ = s.proc.Signal(os.Kill)
}

// Info is a point-in-time snapshot of a session's state.
type Info struct {
	ID        string
	AgentType sandbox.AgentType
	PID       int
	Status    Status
	StartedAt time.Time
}

// PID returns the sandbox process PID (0 if not started).
func (s *Session) PID() int {
	return s.proc.Pid()
}

func (s *Session) info() Info {
	s.mu.Lock()
	status := s.status
	s.mu.Unlock()
	return Info{
		ID:        s.ID,
		AgentType: s.AgentType,
		PID:       s.proc.Pid(),
		Status:    status,
		StartedAt: s.StartedAt,
	}
}
