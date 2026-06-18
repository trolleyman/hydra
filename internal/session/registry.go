package session

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// ErrNotFound is returned when no session exists for an ID.
var ErrNotFound = fmt.Errorf("session not found")

// ErrExists is returned when starting a session whose ID is already running.
var ErrExists = fmt.Errorf("session already exists")

// StartOptions describes a session to launch. It embeds the sandbox options
// plus the head ID and initial terminal size.
type StartOptions struct {
	ID      string
	Sandbox sandbox.Options
	Rows    uint16
	Cols    uint16
	// Ephemeral marks a throwaway session (e.g. a web bash shell) that should be
	// terminated once its last attacher disconnects and nobody reattaches within
	// a short grace period, and removed from the registry as soon as it exits.
	// Unlike agents, it is not meant to outlive its terminal.
	Ephemeral bool
}

// Registry owns all live agent sessions for the daemon.
type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	onExit   func(Info)
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{sessions: make(map[string]*Session)}
}

// SetOnExit registers a callback invoked (off the read goroutine) whenever a
// session's process exits. Used to update the DB/status immediately.
func (r *Registry) SetOnExit(fn func(Info)) {
	r.mu.Lock()
	r.onExit = fn
	r.mu.Unlock()
}

// Start builds the sandbox command, launches it under a PTY, and registers the
// session. It returns ErrExists if a live session with the same ID exists.
func (r *Registry) Start(opts StartOptions) (*Session, error) {
	if err := r.reserve(opts.ID); err != nil {
		return nil, errtrace.Wrap(err)
	}

	spec, err := sandbox.BuildSpec(opts.Sandbox)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("build sandbox spec: %w", err))
	}

	proc, err := startProcess(spec, opts.Rows, opts.Cols)
	if err != nil {
		spec.Cleanup()
		return nil, errtrace.Wrap(fmt.Errorf("start sandboxed process: %w", err))
	}

	return r.register(opts.ID, opts.Sandbox.AgentType, opts.Sandbox.WorktreePath, opts.Rows, opts.Cols, opts.Ephemeral, proc, spec.Cleanup), nil
}

// StartWithProc registers a session backed by an already-running PTY (e.g. a
// child spawned inside a shared namespace host, whose master fd was passed back
// to the daemon) instead of launching its own sandbox process. The proc is
// closed when the session exits.
func (r *Registry) StartWithProc(id string, agentType sandbox.AgentType, worktree string, rows, cols uint16, ephemeral bool, proc PTY) (*Session, error) {
	if err := r.reserve(id); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return r.register(id, agentType, worktree, rows, cols, ephemeral, proc, func() { _ = proc.Close() }), nil
}

// reserve verifies no live session holds id, evicting an exited one so the id
// can be reused. The brief unlocked gap before register mirrors the original
// build-then-insert flow.
func (r *Registry) reserve(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.sessions[id]; ok {
		existing.mu.Lock()
		live := existing.status != StatusExited
		existing.mu.Unlock()
		if live {
			return errtrace.Wrap(ErrExists)
		}
		delete(r.sessions, id)
	}
	return nil
}

// register wires a started proc into a Session, stores it, and launches the
// read loop. cleanup runs once after the process exits.
func (r *Registry) register(id string, agentType sandbox.AgentType, worktree string, rows, cols uint16, ephemeral bool, proc PTY, cleanup func()) *Session {
	s := &Session{
		ID:           id,
		AgentType:    agentType,
		WorktreePath: worktree,
		StartedAt:    time.Now(),
		proc:         proc,
		scroll:       newRing(defaultScrollback),
		cleanup:      cleanup,
		attachers:    make(map[*attacher]struct{}),
		rows:         rows,
		cols:         cols,
		status:       StatusRunning,
		ephemeral:    ephemeral,
	}

	r.mu.Lock()
	r.sessions[id] = s
	r.mu.Unlock()

	go s.readLoop(func(done *Session) {
		r.mu.RLock()
		fn := r.onExit
		r.mu.RUnlock()
		if fn != nil {
			fn(done.info())
		}
		// Ephemeral sessions (web bash shells) don't outlive their process, so
		// drop them from the registry immediately rather than lingering as exited.
		if done.ephemeral {
			r.Remove(done.ID)
		}
	})

	return s
}

// Get returns the session for id, if present.
func (r *Registry) Get(id string) (*Session, bool) {
	r.mu.RLock()
	s, ok := r.sessions[id]
	r.mu.RUnlock()
	return s, ok
}

// IsLive reports whether a session for id exists and has not exited. An exited
// session lingers in the map until replaced, so callers deciding whether to
// (re)start must use this rather than Get's mere presence check.
func (r *Registry) IsLive(id string) bool {
	s, ok := r.Get(id)
	if !ok {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status != StatusExited
}

// Attach returns a consumer handle that replays scrollback then streams live
// output. Returns ErrNotFound if the session is unknown. Pass rows/cols of 0 to
// attach without resizing the PTY — the session keeps its current width, so an
// observer (or a client that hasn't measured its layout yet) never reflows the
// agent's output for everyone else.
func (r *Registry) Attach(id string, rows, cols uint16) (*Attachment, error) {
	s, ok := r.Get(id)
	if !ok {
		return nil, errtrace.Wrap(ErrNotFound)
	}
	return s.attach(rows, cols), nil
}

// Write sends bytes to the session's PTY (agent stdin).
func (r *Registry) Write(id string, data []byte) error {
	s, ok := r.Get(id)
	if !ok {
		return errtrace.Wrap(ErrNotFound)
	}
	return errtrace.Wrap(s.write(data))
}

// Resize updates the session's PTY window size.
func (r *Registry) Resize(id string, rows, cols uint16) error {
	s, ok := r.Get(id)
	if !ok {
		return errtrace.Wrap(ErrNotFound)
	}
	return errtrace.Wrap(s.resize(rows, cols))
}

// Kill terminates the session's process (SIGTERM, then removes it). The
// readLoop performs cleanup and fires onExit. Returns nil if already gone.
func (r *Registry) Kill(id string) error {
	s, ok := r.Get(id)
	if !ok {
		return nil
	}
	s.stop()
	return nil
}

// KillNow forcibly terminates the session immediately (SIGKILL).
func (r *Registry) KillNow(id string) error {
	s, ok := r.Get(id)
	if !ok {
		return nil
	}
	s.kill()
	return nil
}

// Remove deletes an exited session from the registry, freeing its scrollback.
func (r *Registry) Remove(id string) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

// KillMatching terminates and removes every session whose ID has the given
// prefix. Used to tear down a head's web bash shells (`<head>-shell…`) when the
// head itself is killed, so they don't outlive the agent (and its worktree).
// Best-effort.
func (r *Registry) KillMatching(prefix string) {
	r.mu.RLock()
	var ids []string
	for id := range r.sessions {
		if strings.HasPrefix(id, prefix) {
			ids = append(ids, id)
		}
	}
	r.mu.RUnlock()
	for _, id := range ids {
		_ = r.Kill(id)
		r.Remove(id)
	}
}

// Snapshot returns info for all known sessions.
func (r *Registry) Snapshot() []Info {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Info, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s.info())
	}
	return out
}

// StopAll signals every live session to terminate (used on daemon drain).
func (r *Registry) StopAll() {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, s := range r.sessions {
		s.stop()
	}
}
