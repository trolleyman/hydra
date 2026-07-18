package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/claudestream"
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
	mu                sync.RWMutex
	sessions          map[string]*Session
	onExit            func(Info)
	onChatAPIError    func(id, msg string)
	onChatResult      func(id string)
	onChatStep        func(id string)
	onChatPlanApprove func(id, requestID string, input json.RawMessage)
	onChatThinking    func(id, messageID string, durationMS int64)
	onChatPlanSeed    func(id string) string
	onChatPlanChange  func(id, planJSON string)
	onChatModel       func(id, model string)
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

// SetOnChatAPIError registers a callback invoked (off the read goroutine) when a
// chat-mode session's stdout carries an API-error assistant message - the CLI's
// signal that a turn failed mid-response. The daemon wires it to flip the head
// into an error status. id is the session/head id; msg is the error text.
func (r *Registry) SetOnChatAPIError(fn func(id, msg string)) {
	r.mu.Lock()
	r.onChatAPIError = fn
	r.mu.Unlock()
}

// SetOnChatResult registers a callback invoked (off the read goroutine) each
// time a chat-mode session's stdout carries a `result` line - the end of a user
// turn. The daemon wires it to drain the head's next queued message. id is the
// session/head id.
func (r *Registry) SetOnChatResult(fn func(id string)) {
	r.mu.Lock()
	r.onChatResult = fn
	r.mu.Unlock()
}

// SetOnChatStep registers a callback invoked (off the read goroutine) each time
// a chat-mode session's stdout carries a completed main-conversation assistant
// line - a mid-turn step boundary (see claudestream.RingFilter.OnStep). The
// daemon wires it to drain queued messages into the running turn early.
func (r *Registry) SetOnChatStep(fn func(id string)) {
	r.mu.Lock()
	r.onChatStep = fn
	r.mu.Unlock()
}

// SetOnChatPlanApproval registers a callback invoked (off the read goroutine)
// when a chat-mode session's stdout carries a can_use_tool control_request for
// ExitPlanMode - the plan-approval gate a head hits when it leaves plan mode.
// Chat heads run with --permission-prompt-tool stdio, so this gate arrives as a
// control_request nothing answers; the daemon wires this to auto-approve it by
// writing the allow control_response back to the session's stdin. id is the
// session/head id; requestID/input come from the control_request.
func (r *Registry) SetOnChatPlanApproval(fn func(id, requestID string, input json.RawMessage)) {
	r.mu.Lock()
	r.onChatPlanApprove = fn
	r.mu.Unlock()
}

// SetOnChatThinking registers a callback invoked (off the read goroutine) each
// time a chat-mode session's stream completes a thinking block, with the head
// id, the block's Claude message id, and the wall-clock duration Hydra measured.
// The daemon wires this to persist the duration to the head's sidecar so a
// reload/resume can render "Thought for Xs" without the browser timing it.
func (r *Registry) SetOnChatThinking(fn func(id, messageID string, durationMS int64)) {
	r.mu.Lock()
	r.onChatThinking = fn
	r.mu.Unlock()
}

// SetOnChatPlanSeed registers a callback that supplies the persisted plan JSON
// (Agent.Plan) for a head, called synchronously when a chat session registers,
// so the session's plan tracker resumes from where the last session left off
// (a TaskUpdate after a daemon restart still finds its task).
func (r *Registry) SetOnChatPlanSeed(fn func(id string) string) {
	r.mu.Lock()
	r.onChatPlanSeed = fn
	r.mu.Unlock()
}

// SetOnChatPlanChange registers a callback invoked (off the read goroutine)
// each time a chat-mode session's stdout changes the head's plan/to-do list
// (a TaskCreate/TaskUpdate/TodoWrite or a create's result). The daemon wires
// it to persist the new plan JSON onto the agent record, so the durable copy
// stays fresh with no browser attached.
func (r *Registry) SetOnChatPlanChange(fn func(id, planJSON string)) {
	r.mu.Lock()
	r.onChatPlanChange = fn
	r.mu.Unlock()
}

// SetOnChatModel registers a callback invoked (off the read goroutine) when a
// chat-mode session's stdout carries a system:init line naming the active
// model - session start and every /model change. The daemon wires it to
// persist the head's current model, so the selector shows the right one on
// load even if no browser was attached when the model changed.
func (r *Registry) SetOnChatModel(fn func(id, model string)) {
	r.mu.Lock()
	r.onChatModel = fn
	r.mu.Unlock()
}

// ChatPlanJSON returns the current incrementally-tracked plan for a session
// ("" when the session or its plan doesn't exist). Exited sessions still
// answer while they remain registered.
func (r *Registry) ChatPlanJSON(id string) string {
	r.mu.RLock()
	s, ok := r.sessions[id]
	r.mu.RUnlock()
	if !ok {
		return ""
	}
	return s.PlanJSON()
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

	return r.register(opts.ID, opts.Sandbox.AgentType, opts.Sandbox.WorktreePath, opts.Rows, opts.Cols, opts.Ephemeral, KindTerminal, proc, spec.Cleanup), nil
}

// StartWithProc registers a session backed by an already-running process (e.g.
// a child spawned inside a shared namespace host, whose fds were passed back
// to the daemon) instead of launching its own sandbox process. kind says what
// the byte stream carries (terminal VT100 vs chat-mode JSONL). The proc is
// closed when the session exits.
func (r *Registry) StartWithProc(id string, agentType sandbox.AgentType, worktree string, rows, cols uint16, ephemeral bool, kind Kind, proc PTY) (*Session, error) {
	if err := r.reserve(id); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return r.register(id, agentType, worktree, rows, cols, ephemeral, kind, proc, func() { _ = proc.Close() }), nil
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
func (r *Registry) register(id string, agentType sandbox.AgentType, worktree string, rows, cols uint16, ephemeral bool, kind Kind, proc PTY, cleanup func()) *Session {
	if kind == "" {
		kind = KindTerminal
	}
	scrollback := defaultScrollback
	var ringFilter *claudestream.RingFilter
	if kind == KindChat {
		scrollback = chatScrollback
		ringFilter = &claudestream.RingFilter{}
		// An API-error line in the live stdout flips the head into an error
		// status. The filter runs under the session lock, so dispatch the real
		// work (a DB/status write) on its own goroutine.
		ringFilter.OnAPIError = func(msg string) {
			r.mu.RLock()
			fn := r.onChatAPIError
			r.mu.RUnlock()
			if fn != nil {
				go fn(id, msg)
			}
		}
		// A `result` line ends a user turn; dispatch the queue-drain off the read
		// goroutine (it writes to the session's stdin, which must not deadlock
		// against the read side under the session lock).
		ringFilter.OnResult = func() {
			r.mu.RLock()
			fn := r.onChatResult
			r.mu.RUnlock()
			if fn != nil {
				go fn(id)
			}
		}
		// A completed assistant line is a mid-turn step boundary; same
		// off-the-read-goroutine dispatch rules as OnResult. Ordering across
		// these concurrent dispatches is restored by the queue's own send
		// serialization (ChatQueue.sendMu).
		ringFilter.OnStep = func() {
			r.mu.RLock()
			fn := r.onChatStep
			r.mu.RUnlock()
			if fn != nil {
				go fn(id)
			}
		}
		// An ExitPlanMode can_use_tool control_request is the plan-approval gate;
		// dispatch the auto-approve (a stdin write) off the read goroutine, same
		// as the drains, so it can't deadlock against the read side under the
		// session lock.
		ringFilter.OnPlanApproval = func(requestID string, input json.RawMessage) {
			r.mu.RLock()
			fn := r.onChatPlanApprove
			r.mu.RUnlock()
			if fn != nil {
				go fn(id, requestID, input)
			}
		}
		// Incremental plan tracking: seed from the persisted copy (synchronously,
		// BEFORE the read loop starts, so no line can beat the seed), then persist
		// each change off the read goroutine like the other hooks.
		r.mu.RLock()
		seedFn := r.onChatPlanSeed
		r.mu.RUnlock()
		ringFilter.Plan = claudestream.NewPlanTracker()
		if seedFn != nil {
			ringFilter.Plan.Seed(seedFn(id))
		}
		ringFilter.OnPlanChange = func(planJSON string) {
			r.mu.RLock()
			fn := r.onChatPlanChange
			r.mu.RUnlock()
			if fn != nil {
				go fn(id, planJSON)
			}
		}
		// A system:init line names the active model; persist it off the read
		// goroutine like the other hooks. Deduped PER SESSION (not per head id
		// across the daemon's lifetime): a head killed and respawned under the
		// same id starts a fresh DB row, and a longer-lived dedupe would skip
		// re-persisting an unchanged model into it. lastModel needs no lock -
		// Filter runs under the session lock, so calls are serialized.
		lastModel := ""
		ringFilter.OnModel = func(model string) {
			if model == lastModel {
				return
			}
			lastModel = model
			r.mu.RLock()
			fn := r.onChatModel
			r.mu.RUnlock()
			if fn != nil {
				go fn(id, model)
			}
		}
		// A completed thinking block: persist its measured duration to the head's
		// sidecar (a small disk write), dispatched off the read goroutine like the
		// others. Filter also injects a live hydra_thinking line for attached
		// clients; this callback is only the durable half.
		ringFilter.OnThinking = func(messageID string, durationMS int64) {
			r.mu.RLock()
			fn := r.onChatThinking
			r.mu.RUnlock()
			if fn != nil {
				go fn(id, messageID, durationMS)
			}
		}
	}
	s := &Session{
		ID:           id,
		AgentType:    agentType,
		WorktreePath: worktree,
		StartedAt:    time.Now(),
		Kind:         kind,
		proc:         proc,
		scroll:       newRing(scrollback),
		ringFilter:   ringFilter,
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

// ReapDead forces the session for id into the exited state if its process has
// died without the read loop noticing (e.g. the PTY never reported EOF). Returns
// true if it reaped one. The liveness reconciler and boot resume use this to
// unstick a session that would otherwise stay IsLive forever, pinning the head
// at "running". A no-op (returns false) when the session is unknown, already
// exited, or still alive.
func (r *Registry) ReapDead(id string) bool {
	s, ok := r.Get(id)
	if !ok {
		return false
	}
	return s.reapIfDead()
}

// Attach returns a consumer handle that replays scrollback then streams live
// output. Returns ErrNotFound if the session is unknown. Pass rows/cols of 0 to
// attach without resizing the PTY - the session keeps its current width, so an
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
// prefix. Used to tear down a head's web bash shells (`<head>-shell...`) when the
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
