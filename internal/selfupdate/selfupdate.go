// Package selfupdate rebuilds Hydra from its own source and restarts into the
// result, without a supervisor and without a window where the port is unbound.
//
// The shape is deliberate. A restart is NOT "exit and let systemd start us
// again": it is syscall.Exec, which keeps the PID (so systemd's start rate limit
// is never involved, and the same code path works under `hydra server` in a
// terminal with no supervisor at all) and lets open file descriptors - today the
// TCP listener, see docs/deployment.md for the plan to include the PTYs - be
// carried into the new image.
//
// An update is a restart with a build in front of it, and the ordering is the
// whole safety argument: the running server keeps serving while the build runs,
// and nothing is swapped until a fresh binary has been built AND proved to
// start. A failed build changes nothing at all.
package selfupdate

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
)

// The wire format lives in api/openapi.yaml and is generated for both the
// daemon and the browser, so the phases the UI labels and the kinds it narrows
// on cannot drift from what is emitted here. Event is flat because the manager
// constructs these and fans them out internally; the browser reads the same
// bytes through ServerUpdateFrame, which narrows each kind to the field it
// carries.
type Event = api.ServerUpdateEvent

// Phase names the stage an update has reached. Sent to the UI verbatim.
const (
	PhaseBuilding   = api.ServerUpdatePhaseBuilding
	PhaseVerifying  = api.ServerUpdatePhaseVerifying
	PhaseSwapping   = api.ServerUpdatePhaseSwapping
	PhaseRestarting = api.ServerUpdatePhaseRestarting
)

// EventKind discriminates the frames sent to a subscriber.
const (
	KindPhase = api.ServerUpdateEventKindPhase
	KindLog   = api.ServerUpdateEventKindLog
	KindDone  = api.ServerUpdateEventKindDone
)

// Manager owns the one-at-a-time update job and fans its output out to however
// many browser tabs are watching.
type Manager struct {
	// SourceRoot is the Hydra checkout to build. Empty disables updating.
	SourceRoot string
	// BinPath is the executable to replace - normally os.Executable().
	BinPath string
	// Drain releases everything that must not be held across the exec: live
	// sessions, service and preview subprocesses, the database. Called after a
	// successful swap, immediately before the exec.
	Drain func()
	// KeepFiles returns descriptors to carry into the new image, paired with the
	// environment entries that tell it where to find them. Returning an empty
	// slice is fine - the new process just re-binds.
	KeepFiles func() ([]*os.File, []string, error)

	mu      sync.Mutex
	running bool
	// history lets a tab that connects mid-build (or after a reload) catch up.
	history []Event
	subs    map[chan Event]struct{}
}

// CanRestart reports whether re-exec is possible at all. It needs a real
// executable on disk; `go run` builds one in a temp dir, which is fine, but a
// platform without exec is not.
func (m *Manager) CanRestart() bool {
	if !execSupported {
		return false
	}
	return m.BinPath != ""
}

// CanUpdate reports whether this server can rebuild itself: it has to know where
// its own source is, be able to replace its binary, and have mage on PATH.
//
// The source is the daemon's project root when that root IS the Hydra checkout.
// Hydra manages other people's projects too, and rebuilding the server from one
// of those would be nonsense - so a daemon booted outside the Hydra tree offers
// restart but not update.
func (m *Manager) CanUpdate() bool {
	if !m.CanRestart() || m.SourceRoot == "" {
		return false
	}
	if _, err := exec.LookPath("mage"); err != nil {
		return false
	}
	// The binary's directory has to be writable, since the swap is a rename
	// within it.
	if unix := filepath.Dir(m.BinPath); unix != "" {
		f, err := os.CreateTemp(unix, ".hydra-update-probe")
		if err != nil {
			return false
		}
		name := f.Name()
		_ = f.Close()
		_ = os.Remove(name)
	}
	return true
}

// IsHydraSource reports whether dir is a Hydra checkout, by reading the module
// line out of its go.mod. Used to decide SourceRoot at startup.
func IsHydraSource(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return false
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		if strings.TrimSpace(line) == "module github.com/trolleyman/hydra" {
			return true
		}
	}
	return false
}

// Running reports whether an update is in flight.
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

// Subscribe returns a channel carrying every event of the current job, starting
// with those already emitted, plus a function to stop listening. A subscriber
// that stops reading is dropped rather than allowed to block the build.
func (m *Manager) Subscribe() (<-chan Event, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch := make(chan Event, 256)
	for _, ev := range m.history {
		select {
		case ch <- ev:
		default:
		}
	}
	if m.subs == nil {
		m.subs = map[chan Event]struct{}{}
	}
	m.subs[ch] = struct{}{}

	return ch, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if _, ok := m.subs[ch]; ok {
			delete(m.subs, ch)
			close(ch)
		}
	}
}

func (m *Manager) emit(ev Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Keep the tail rather than the whole build - enough for a late tab to see
	// what is happening without holding a full `go build ./...` in memory.
	m.history = append(m.history, ev)
	if len(m.history) > 2000 {
		m.history = append([]Event(nil), m.history[len(m.history)-2000:]...)
	}
	for ch := range m.subs {
		select {
		case ch <- ev:
		default: // a stalled reader must not stall the build
		}
	}
}

// ErrAlreadyRunning is returned when an update is asked for while one is in
// flight. The caller should surface it as a conflict rather than queueing.
var ErrAlreadyRunning = fmt.Errorf("an update is already running")

// Restart re-execs the current binary without building anything. It does not
// return on success.
func (m *Manager) Restart() error {
	if !m.CanRestart() {
		return errtrace.Wrap(fmt.Errorf("restart is not supported on this platform"))
	}
	m.emit(Event{Kind: KindPhase, Phase: PhaseRestarting})
	return errtrace.Wrap(m.reexec())
}

// Start kicks off an update in the background and returns immediately. Progress
// arrives through Subscribe. On success the process is replaced and this server
// stops existing, so there is no "finished" to return.
func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return errtrace.Wrap(ErrAlreadyRunning)
	}
	m.running = true
	m.history = nil
	m.mu.Unlock()

	go func() {
		err := m.run(ctx)
		// Only reached when something went wrong - a successful update never
		// returns from the exec.
		m.mu.Lock()
		m.running = false
		m.mu.Unlock()
		if err != nil {
			m.emit(Event{Kind: KindDone, Error: err.Error()})
			return
		}
		m.emit(Event{Kind: KindDone})
	}()
	return nil
}

// run performs the update. Every step before the swap is reversible by doing
// nothing: the new binary is built beside the old one and only moved into place
// once it has been shown to run.
func (m *Manager) run(ctx context.Context) error {
	if !m.CanUpdate() {
		return errtrace.Wrap(fmt.Errorf("this server cannot rebuild itself (no Hydra source root, or mage is not on PATH)"))
	}

	newPath := m.BinPath + ".new"
	_ = os.Remove(newPath)

	m.emit(Event{Kind: KindPhase, Phase: PhaseBuilding})
	// `mage build` regenerates the API stubs and the frontend; the explicit
	// `go build -o` then links the binary we are going to install. The second
	// step is nearly free because the first has already populated the build
	// cache.
	if err := m.runLogged(ctx, "mage", "build"); err != nil {
		return errtrace.Wrap(err)
	}
	if err := m.runLogged(ctx, "go", "build", "-o", newPath, "./"); err != nil {
		return errtrace.Wrap(err)
	}

	m.emit(Event{Kind: KindPhase, Phase: PhaseVerifying})
	if err := m.verify(ctx, newPath); err != nil {
		_ = os.Remove(newPath)
		return errtrace.Wrap(err)
	}

	m.emit(Event{Kind: KindPhase, Phase: PhaseSwapping})
	if err := m.swap(newPath); err != nil {
		return errtrace.Wrap(err)
	}

	m.emit(Event{Kind: KindPhase, Phase: PhaseRestarting})
	// Give the websocket a moment to push the last frames before the process
	// is replaced out from under it.
	time.Sleep(150 * time.Millisecond)
	return errtrace.Wrap(m.reexec())
}

// verify proves the freshly built binary can actually start. `--version` is
// enough: it links, the runtime comes up, and cobra initialises. Anything that
// fails here means the swap must not happen.
func (m *Manager) verify(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("the new binary failed to start (%w): %s", err, strings.TrimSpace(string(out))))
	}
	m.emit(Event{Kind: KindLog, Line: "verified: " + strings.TrimSpace(string(out))})
	return nil
}

// swap moves the new binary into place, keeping the old one as .prev for a
// manual rollback. Both steps are renames within one directory, so each is
// atomic - there is no instant at which BinPath does not exist.
//
// Replacing a running executable is safe: the Go linker unlinks its output
// before writing, processes hold their inode, and the sandbox binds that carry
// this binary into running heads pin it too. They keep the version they started
// with, which is what we want.
func (m *Manager) swap(newPath string) error {
	prev := m.BinPath + ".prev"
	_ = os.Remove(prev)
	if err := os.Rename(m.BinPath, prev); err != nil && !os.IsNotExist(err) {
		return errtrace.Wrap(fmt.Errorf("move the running binary aside: %w", err))
	}
	if err := os.Rename(newPath, m.BinPath); err != nil {
		// Put the old one back rather than leaving no binary at all.
		_ = os.Rename(prev, m.BinPath)
		return errtrace.Wrap(fmt.Errorf("install the new binary: %w", err))
	}
	m.emit(Event{Kind: KindLog, Line: "installed " + m.BinPath + " (previous kept as " + filepath.Base(prev) + ")"})
	return nil
}

// runLogged runs a build command in the source root, streaming both its streams
// to subscribers a line at a time.
func (m *Manager) runLogged(ctx context.Context, name string, args ...string) error {
	m.emit(Event{Kind: KindLog, Line: "$ " + name + " " + strings.Join(args, " ")})

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = m.SourceRoot

	// Both streams share one pipe so the log reads the way it would in a
	// terminal - mage prints its commands to stdout and the compilers write
	// errors to stderr, and separating them scrambles the order.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	drained := make(chan struct{})
	go func() { defer close(drained); m.pump(pr) }()

	runErr := cmd.Run()
	_ = pw.Close()
	<-drained

	if runErr != nil {
		return errtrace.Wrap(fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), runErr))
	}
	return nil
}

func (m *Manager) pump(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		m.emit(Event{Kind: KindLog, Line: sc.Text()})
	}
	// A read error here means the log is truncated, not that the build failed -
	// the command's own exit status is what decides that. Say so and move on.
	if err := sc.Err(); err != nil {
		m.emit(Event{Kind: KindLog, Line: "warn: build output truncated: " + err.Error()})
	}
}

// reexec drains what must not survive, then replaces this process image.
func (m *Manager) reexec() error {
	var keep []*os.File
	var env []string
	if m.KeepFiles != nil {
		var err error
		keep, env, err = m.KeepFiles()
		if err != nil {
			// Not fatal: without the inherited listener the new image just binds
			// the port itself, which costs a sliver of downtime.
			m.emit(Event{Kind: KindLog, Line: "warn: could not carry sockets across the restart: " + err.Error()})
			keep, env = nil, nil
		}
	}
	if m.Drain != nil {
		m.Drain()
	}
	return errtrace.Wrap(execSelf(m.BinPath, keep, env))
}
