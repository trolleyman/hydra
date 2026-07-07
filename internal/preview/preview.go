// Package preview runs live "server" artifacts ([[artifacts]] type = "server"):
// per-project commands that start an HTTP server from a checkout of the
// repository, exposed to the browser through a per-instance reverse-proxy port.
//
// Unlike the run-to-completion generators in internal/artifacts, a preview has
// no cached output and no terminal state - it is a supervised child process
// spun up lazily (an explicit start, or the first proxied request) and torn
// down when idle (zero in-flight proxied requests for the script's idle
// timeout). The proxy listener itself persists, so revisiting a preview link
// after teardown transparently respawns the server.
//
// An instance is keyed by (project root, script name, version), where version
// follows the artifacts vocabulary: a head's live worktree, or a pinned commit
// materialized into a dedicated ephemeral checkout under
// .hydra/local/artifacts/preview/.
package preview

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

const (
	// ReadyMarker is the optional stdout line a server script prints to declare
	// readiness explicitly (e.g. it binds its port early but warms up late).
	// Without it, the first successful HTTP response from the child port counts.
	ReadyMarker = "::hydra:server:ready::"
	// ProgressMarker mirrors internal/artifacts.ProgressMarker for the loading
	// page headline (kept as a separate const to avoid the package dependency).
	ProgressMarker = "::hydra:progress::"

	// DefaultIdleTimeout tears an instance down after this long with zero
	// in-flight proxied requests (open WebSocket tunnels count as in-flight).
	DefaultIdleTimeout = 5 * time.Minute
	// DefaultReadyTimeout bounds spawn-to-ready; server commands often build
	// first, so it is generous.
	DefaultReadyTimeout = 15 * time.Minute
	// stoppedInstanceTTL removes a torn-down commit-pinned instance (freeing its
	// port and ephemeral checkout) after this long without any activity. Live
	// worktree instances are reclaimed by the head reaper instead.
	stoppedInstanceTTL = 2 * time.Hour
	// logRingSize bounds the in-memory per-instance log (most recent lines win).
	logRingSize = 500
)

// State is an instance lifecycle state. Values are distinct from other Hydra
// status enums so a misrouted value is recognizable.
type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateError    State = "error"
)

// Version identifies which checkout of the repository an instance serves.
// Exactly one of WorktreeDir or SHA is set: a head's live worktree (HeadID set
// alongside for teardown bookkeeping), or a pinned commit materialized into an
// ephemeral checkout owned by the instance.
type Version struct {
	HeadID      string
	WorktreeDir string
	SHA         string
}

// key returns the map-key segment for this version, reusing the artifacts
// cache vocabulary (worktree/... vs commit/...).
func (v Version) key() string {
	if v.WorktreeDir != "" {
		return "worktree/" + v.HeadID
	}
	return "commit/" + v.SHA
}

// Label is the human-readable version tag shown in the UI.
func (v Version) Label() string {
	if v.WorktreeDir != "" {
		return "uncommitted"
	}
	if len(v.SHA) > 8 {
		return v.SHA[:8]
	}
	return v.SHA
}

// LogLine is one captured output line, tagged with its stream ("stdout" or
// "stderr") so the UI renders stderr distinctly. Mirrors artifacts.LogLine.
type LogLine struct {
	Text   string `json:"text"`
	Stream string `json:"stream"`
}

// Status is a snapshot of one instance (or a configured-but-never-started
// script, which reports StateStopped with no port).
type Status struct {
	Name      string
	State     State
	Version   string // Version.Label()
	Port      int    // proxy listener port; 0 until a listener exists
	Pid       int    // child pid while starting/running
	Inflight  int    // in-flight proxied requests (incl. open WS tunnels)
	StartedAt time.Time
	Progress  string // latest ::hydra:progress:: headline while starting
	Message   string // error detail when State == StateError
	Log       []LogLine
}

// Authorizer gates proxied requests, implemented by internal/http's
// Authenticator (loopback always passes; remote needs the auth cookie/bearer
// key). A nil Authorizer allows everything.
type Authorizer interface {
	Authorized(r *http.Request) bool
}

// Manager owns every preview instance across projects. Construct with
// NewManager, wire StopHead/StopAll into head/daemon teardown, and run the
// reaper via Run.
type Manager struct {
	mu        sync.Mutex
	instances map[string]*instance

	bindHost string // listener bind host, the web server's resolved host
	auth     Authorizer

	// Timing knobs, overridable in tests.
	idleDefault  time.Duration
	readyDefault time.Duration
	stopGrace    time.Duration
	reapInterval time.Duration

	// sweptRoots tracks which projects have had their orphaned preview
	// checkouts (from a previous daemon run) swept already.
	sweptRoots map[string]bool
}

// NewManager builds a Manager whose proxy listeners bind bindHost (the web
// server's resolved listen host, so previews are exposed exactly when the UI
// is). auth gates proxied requests; nil allows everything.
func NewManager(bindHost string, auth Authorizer) *Manager {
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	return &Manager{
		instances:    map[string]*instance{},
		bindHost:     bindHost,
		auth:         auth,
		idleDefault:  DefaultIdleTimeout,
		readyDefault: DefaultReadyTimeout,
		stopGrace:    5 * time.Second,
		reapInterval: 15 * time.Second,
		sweptRoots:   map[string]bool{},
	}
}

// previewDir is where a project's preview scratch lives (ephemeral commit
// checkouts and per-spawn cow layers), inside the gitignored artifacts dir.
func previewDir(projectRoot string) string {
	return filepath.Join(paths.GetArtifactsDirFromProjectRoot(projectRoot), "preview")
}

func instanceKey(root, script, versionKey string) string {
	return root + "\x00" + script + "\x00" + versionKey
}

// Ensure returns the instance for (root, spec, version), creating its listener
// on first use, and spawns the child if it is not already starting/running.
// The returned Status carries the proxy port the UI should link to.
func (m *Manager) Ensure(root string, spec config.ArtifactScript, version Version) (Status, error) {
	inst, err := m.ensureInstance(root, spec, version)
	if err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	inst.ensureStarted()
	return inst.status(), nil
}

// Peek returns the current status for (root, script, version) without creating
// anything: a configured script with no instance reports StateStopped, port 0.
func (m *Manager) Peek(root string, spec config.ArtifactScript, version Version) Status {
	m.mu.Lock()
	inst := m.instances[instanceKey(root, spec.Name, version.key())]
	m.mu.Unlock()
	if inst == nil {
		return Status{Name: spec.Name, State: StateStopped, Version: version.Label()}
	}
	return inst.status()
}

// Others returns statuses of live instances of this script for OTHER versions
// than the given one (e.g. the page selection moved on but an old demo is
// still running), most recently active first.
func (m *Manager) Others(root string, script string, version Version) []Status {
	cur := instanceKey(root, script, version.key())
	prefix := root + "\x00" + script + "\x00"
	var out []Status
	m.mu.Lock()
	for k, inst := range m.instances {
		if k != cur && strings.HasPrefix(k, prefix) {
			if st := inst.status(); st.State != StateStopped {
				out = append(out, st)
			}
		}
	}
	m.mu.Unlock()
	return out
}

// Stop tears down the child of (root, script, version) but keeps the instance
// and its listener for a later respawn. No-op if there is no such instance.
func (m *Manager) Stop(root, script string, version Version) {
	m.mu.Lock()
	inst := m.instances[instanceKey(root, script, version.key())]
	m.mu.Unlock()
	if inst != nil {
		inst.stopChild(StateStopped, "")
	}
}

// StopHead removes every live-worktree instance belonging to the given head
// (its worktree is going away). Commit-pinned instances are head-independent
// and unaffected.
func (m *Manager) StopHead(root, headID string) {
	m.removeMatching(func(inst *instance) bool {
		return inst.root == root && inst.version.HeadID == headID && inst.version.WorktreeDir != ""
	})
}

// StopAll tears down every instance: children killed, listeners closed,
// ephemeral checkouts removed. Called on daemon shutdown.
func (m *Manager) StopAll() {
	m.removeMatching(func(*instance) bool { return true })
}

// removeMatching removes (fully: child, listener, checkout) every instance the
// predicate selects.
func (m *Manager) removeMatching(match func(*instance) bool) {
	var doomed []*instance
	m.mu.Lock()
	for k, inst := range m.instances {
		if match(inst) {
			doomed = append(doomed, inst)
			delete(m.instances, k)
		}
	}
	m.mu.Unlock()
	for _, inst := range doomed {
		inst.remove()
	}
}

// ensureInstance returns the existing instance or creates one: sweep orphans
// once per project, materialize the commit checkout if needed, allocate a
// listener port from the project's configured range, and start serving.
func (m *Manager) ensureInstance(root string, spec config.ArtifactScript, version Version) (*instance, error) {
	key := instanceKey(root, spec.Name, version.key())
	m.mu.Lock()
	if inst := m.instances[key]; inst != nil {
		// Config may have changed since the instance was created (timeouts,
		// command); adopt the latest spec for future spawns.
		inst.mu.Lock()
		inst.spec = spec
		inst.mu.Unlock()
		m.mu.Unlock()
		return inst, nil
	}
	sweep := !m.sweptRoots[root]
	m.sweptRoots[root] = true
	m.mu.Unlock()

	if sweep {
		m.sweepOrphans(root)
	}

	runDir := version.WorktreeDir
	ownsCheckout := false
	if runDir == "" {
		dir := filepath.Join(previewDir(root), "checkouts", spec.Name+"-"+version.SHA[:min(len(version.SHA), 12)])
		// Defensively clear any stale worktree at the path before adding.
		_ = git.RemoveWorktree(root, dir)
		_ = os.RemoveAll(dir)
		if err := git.AddDetachedWorktree(root, dir, version.SHA); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("materialize preview checkout: %w", err))
		}
		runDir = dir
		ownsCheckout = true
	}

	ln, port, err := m.allocListener(root)
	if err != nil {
		if ownsCheckout {
			_ = git.RemoveWorktree(root, runDir)
			_ = os.RemoveAll(runDir)
		}
		return nil, errtrace.Wrap(err)
	}

	inst := &instance{
		mgr:          m,
		root:         root,
		spec:         spec,
		version:      version,
		runDir:       runDir,
		ownsCheckout: ownsCheckout,
		ln:           ln,
		port:         port,
		state:        StateStopped,
		lastActive:   time.Now(),
	}
	inst.srv = &http.Server{
		Handler:           http.HandlerFunc(inst.serveHTTP),
		ReadHeaderTimeout: 30 * time.Second,
	}

	m.mu.Lock()
	if existing := m.instances[key]; existing != nil {
		// Lost a race; discard ours.
		m.mu.Unlock()
		_ = ln.Close()
		if ownsCheckout {
			_ = git.RemoveWorktree(root, runDir)
			_ = os.RemoveAll(runDir)
		}
		return existing, nil
	}
	m.instances[key] = inst
	m.mu.Unlock()

	go func() { _ = inst.srv.Serve(ln) }()
	return inst, nil
}

// allocListener binds the first free port in the project's configured preview
// range on the manager's bind host. Busy ports (other daemons, dev servers,
// our own instances) are skipped.
func (m *Manager) allocListener(root string) (net.Listener, int, error) {
	cfg, _ := config.Load(root)
	lo, hi := cfg.ResolvePreviewPortRange()
	for port := lo; port <= hi; port++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(m.bindHost, fmt.Sprintf("%d", port)))
		if err == nil {
			return ln, port, nil
		}
	}
	return nil, 0, errtrace.Errorf("no free preview port in %d-%d", lo, hi)
}

// sweepOrphans removes preview checkouts left behind by a previous daemon run
// (crash or unclean shutdown). Called once per project before the first
// instance is created, so nothing here can belong to a live instance.
func (m *Manager) sweepOrphans(root string) {
	dir := filepath.Join(previewDir(root), "checkouts")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		_ = git.RemoveWorktree(root, p)
		_ = os.RemoveAll(p)
	}
	_ = git.PruneWorktrees(root)
}

// Run drives the reaper until ctx is done: idle instances are torn down,
// instances whose live worktree vanished (head killed/merged via any path) are
// removed entirely, and long-stopped commit instances release their checkout
// and port. Call as a goroutine.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(m.reapInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.StopAll()
			return
		case <-t.C:
			m.reap()
		}
	}
}

// reap applies the periodic lifecycle rules to every instance.
func (m *Manager) reap() {
	m.mu.Lock()
	all := make([]*instance, 0, len(m.instances))
	for _, inst := range m.instances {
		all = append(all, inst)
	}
	m.mu.Unlock()

	now := time.Now()
	for _, inst := range all {
		// A head's worktree was removed: the instance is unservable, remove it.
		if inst.version.WorktreeDir != "" {
			if _, err := os.Stat(inst.version.WorktreeDir); err != nil {
				m.removeMatching(func(x *instance) bool { return x == inst })
				continue
			}
		}
		inst.mu.Lock()
		state := inst.state
		idleFor := now.Sub(inst.lastActive)
		inflight := inst.inflight
		idleTimeout := inst.idleTimeout()
		inst.mu.Unlock()

		switch state {
		case StateRunning, StateStarting:
			if inflight == 0 && idleFor > idleTimeout {
				inst.stopChild(StateStopped, "")
			}
		case StateStopped, StateError:
			// Commit-pinned instances hold a checkout + port; release them after a
			// long quiet period. Worktree instances are cheap (no checkout) and die
			// with their head, so they are kept for instant respawn.
			if inst.ownsCheckout && idleFor > stoppedInstanceTTL {
				m.removeMatching(func(x *instance) bool { return x == inst })
			}
		}
	}
}
