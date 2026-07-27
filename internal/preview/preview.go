// Package preview runs live "server" artifacts ([[artifacts]] type = "server"):
// per-project commands that start an HTTP server from a checkout of the
// repository, exposed to the browser through a stable per-slot reverse-proxy
// port.
//
// Unlike the run-to-completion generators in internal/artifacts, a preview has
// no cached output and no terminal state - it is a supervised child process
// spun up lazily (an explicit start, or the first proxied request) and torn
// down when idle (zero in-flight proxied requests for the script's idle
// timeout). The proxy listener itself persists, so revisiting a preview link
// after teardown transparently respawns the server.
//
// There is exactly one visible server per (project, script, head): a "slot"
// that owns the proxy port and follows the diff viewer's "to" selection. The
// selection maps to a channel - the head's live worktree, a pinned commit
// (materialized into a dedicated ephemeral checkout under
// .hydra/local/artifacts/preview/), or the branch tip. Switching channels swaps
// the backing server; the branch-tip channel additionally rebuilds in the
// background and hot-swaps when the tip moves, so the URL never changes. Those
// backing servers are `instance`s, an implementation detail behind the slot.
package preview

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
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

// Version identifies which checkout of the repository a slot should serve, from
// the diff viewer's "to" selection. Exactly one backing shape is set: a head's
// live worktree (WorktreeDir), or a commit (SHA). A SHA with Branch set is the
// branch-tip channel - it follows that branch, rebuilding in the background when
// the tip moves; a SHA without Branch is a pinned commit that never moves.
// HeadID scopes the slot to the viewing head's page.
type Version struct {
	HeadID      string
	WorktreeDir string
	SHA         string
	Branch      string
}

// channelID names the slot channel this version selects. A slot keeps serving
// its current server as long as the channel is unchanged; a different channel
// swaps the backing server. Tip channels omit the SHA so a moved tip stays the
// same channel (handled by background hot-swap), pinned commits include it.
func (v Version) channelID() string {
	switch {
	case v.WorktreeDir != "":
		return "worktree"
	case v.Branch != "":
		return "tip:" + v.Branch
	default:
		return "commit:" + v.SHA
	}
}

// Label is the human-readable version tag shown in the UI.
func (v Version) Label() string {
	if v.WorktreeDir != "" {
		return "uncommitted"
	}
	return shortSHA(v.SHA)
}

func shortSHA(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

// LogLine is one captured output line, tagged with its stream ("stdout" or
// "stderr") so the UI renders stderr distinctly. Mirrors artifacts.LogLine.
type LogLine struct {
	Text   string `json:"text"`
	Stream string `json:"stream"`
}

// Status is a snapshot of one slot's front server (or a configured-but-never-
// started script, which reports StateStopped with no port).
type Status struct {
	Name      string
	State     State
	Version   string // Version.Label() of the front server
	Port      int    // slot proxy listener port; 0 until a slot exists
	Pid       int    // child pid while starting/running
	Inflight  int    // in-flight proxied requests (incl. open WS tunnels)
	StartedAt time.Time
	Progress  string // latest ::hydra:progress:: headline while starting
	Message   string // error detail when State == StateError
	Stale     bool   // worktree channel: live code changed since this server built
	Log       []LogLine
}

// Authorizer gates proxied requests, implemented by internal/http's
// Authenticator (loopback always passes; remote needs the auth cookie/bearer
// key). A nil Authorizer allows everything.
type Authorizer interface {
	Authorized(r *http.Request) bool
}

// Manager owns every preview slot across projects. Construct with NewManager,
// wire StopHead/StopAll into head/daemon teardown, and run the reaper via Run.
type Manager struct {
	mu    sync.Mutex
	slots map[string]*slot

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

	// warnFallback logs the wildcard-bind -> loopback fallback once per daemon
	// run (see allocListener), rather than once per slot.
	warnFallback sync.Once
}

// NewManager builds a Manager whose proxy listeners bind bindHost (the web
// server's resolved listen host, so previews are exposed exactly when the UI
// is). auth gates proxied requests; nil allows everything.
func NewManager(bindHost string, auth Authorizer) *Manager {
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	return &Manager{
		slots:        map[string]*slot{},
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

// slotKey identifies the one slot for a (project, script, head) view. The
// version/channel is deliberately NOT part of the key: one slot follows the
// selection, rather than a new instance piling up per version.
func slotKey(root, script, headID string) string {
	return root + "\x00" + script + "\x00" + headID
}

// Ensure returns the slot for (root, spec, head), creating its listener on
// first use, points it at the selected version's channel, and starts the
// server. The returned Status carries the proxy port the UI should link to.
func (m *Manager) Ensure(root string, spec config.ArtifactScript, version Version) (Status, error) {
	s, err := m.ensureSlot(root, spec, version)
	if err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	if err := s.retarget(spec, version, true); err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	return s.status(), nil
}

// Peek returns the current status of the slot's front server without creating
// or starting anything: no slot yet reports StateStopped with port 0.
func (m *Manager) Peek(root string, spec config.ArtifactScript, version Version) Status {
	m.mu.Lock()
	s := m.slots[slotKey(root, spec.Name, version.HeadID)]
	m.mu.Unlock()
	if s == nil {
		return Status{Name: spec.Name, State: StateStopped, Version: version.Label()}
	}
	return s.status()
}

// Stop tears down the slot's server for (root, script, head) but keeps the slot
// and its listener for a later respawn. No-op if there is no such slot.
func (m *Manager) Stop(root, script string, version Version) {
	m.mu.Lock()
	s := m.slots[slotKey(root, script, version.HeadID)]
	m.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	active := s.active
	pending := s.pending
	s.pending = nil
	s.mu.Unlock()
	if active != nil {
		active.stopChild(StateStopped, "")
	}
	if pending != nil {
		go pending.teardown()
	}
}

// StopHead removes every slot belonging to the given head (its page is going
// away with the worktree). Commit and tip channels the head was viewing go with
// it - the slot is per-head.
func (m *Manager) StopHead(root, headID string) {
	m.removeSlotsMatching(func(s *slot) bool { return s.root == root && s.headID == headID })
}

// StopAll tears down every slot: servers killed, listeners closed, ephemeral
// checkouts removed. Called on daemon shutdown.
func (m *Manager) StopAll() {
	m.removeSlotsMatching(func(*slot) bool { return true })
}

// removeSlotsMatching removes (fully: servers, listener, checkouts) every slot
// the predicate selects.
func (m *Manager) removeSlotsMatching(match func(*slot) bool) {
	var doomed []*slot
	m.mu.Lock()
	for k, s := range m.slots {
		if match(s) {
			doomed = append(doomed, s)
			delete(m.slots, k)
		}
	}
	m.mu.Unlock()
	for _, s := range doomed {
		s.teardown()
	}
}

// removeSlot removes one slot from the map (if still current) and tears it down.
func (m *Manager) removeSlot(s *slot) {
	m.mu.Lock()
	if m.slots[s.key] == s {
		delete(m.slots, s.key)
	}
	m.mu.Unlock()
	s.teardown()
}

// ensureSlot returns the existing slot or creates one: sweep orphans once per
// project, allocate a listener port from the project's configured range, and
// start serving. Instances (backing servers) are created later by retarget.
func (m *Manager) ensureSlot(root string, spec config.ArtifactScript, version Version) (*slot, error) {
	key := slotKey(root, spec.Name, version.HeadID)
	m.mu.Lock()
	if s := m.slots[key]; s != nil {
		m.mu.Unlock()
		return s, nil
	}
	sweep := !m.sweptRoots[root]
	m.sweptRoots[root] = true
	m.mu.Unlock()

	if sweep {
		m.sweepOrphans(root)
	}

	ln, port, err := m.allocListener(root)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s := &slot{
		mgr:    m,
		root:   root,
		name:   spec.Name,
		headID: version.HeadID,
		key:    key,
		ln:     ln,
		port:   port,
		spec:   spec,
	}
	s.srv = &http.Server{
		Handler:           http.HandlerFunc(s.serveHTTP),
		ReadHeaderTimeout: 30 * time.Second,
	}

	m.mu.Lock()
	if existing := m.slots[key]; existing != nil {
		m.mu.Unlock()
		_ = ln.Close()
		return existing, nil
	}
	m.slots[key] = s
	m.mu.Unlock()

	go func() { _ = s.srv.Serve(ln) }()
	return s, nil
}

// allocListener binds the first free port in the project's configured preview
// range on the manager's bind host. Busy ports (other daemons, dev servers,
// our own slots) are skipped.
//
// A WILDCARD bind host (0.0.0.0 - an exposed deploy, `mage prod` /
// HYDRA_API_ADDR=0.0.0.0:...) has a failure mode a loopback bind does not: it
// collides with anything already holding that port on a *specific* address,
// even though nothing holds the wildcard. `tailscale serve --https=$p
// http://127.0.0.1:$p` - what `mage deploy:tailscale` offers to run across the
// whole preview range - does exactly that on the tailnet addresses, so an
// exposed Hydra behind Tailscale finds every port in the range unbindable and
// previews die with "no free preview port". Falling back to loopback keeps them
// working: the TLS front proxies to 127.0.0.1:$p, which is what we then bind.
// The wildcard is still tried first, port by port, so nothing changes when it
// is available.
func (m *Manager) allocListener(root string) (net.Listener, int, error) {
	cfg, _ := config.Load(root)
	lo, hi := cfg.ResolvePreviewPortRange()
	var lastErr error
	for _, host := range m.bindCandidates() {
		for port := lo; port <= hi; port++ {
			ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
			if err == nil {
				if host != m.bindHost {
					m.warnFallback.Do(func() {
						log.Printf("previews: ports %d-%d are all taken on %s (another process holds them on a specific address); "+
							"binding previews on %s instead - remote browsers reach them only through a TLS front or proxy (see docs/remote-access.md)",
							lo, hi, m.bindHost, host)
					})
				}
				return ln, port, nil
			}
			lastErr = err
		}
	}
	if lastErr != nil {
		return nil, 0, errtrace.Errorf("no free preview port in %d-%d on %s: %w", lo, hi, m.bindHost, lastErr)
	}
	return nil, 0, errtrace.Errorf("no free preview port in %d-%d on %s", lo, hi, m.bindHost)
}

// bindCandidates is the ordered list of hosts allocListener tries: the
// configured bind host, plus loopback as a fallback when that host is the
// wildcard (see allocListener for why).
func (m *Manager) bindCandidates() []string {
	if isWildcardHost(m.bindHost) {
		return []string{m.bindHost, "127.0.0.1"}
	}
	return []string{m.bindHost}
}

// isWildcardHost reports whether host means "every interface" (0.0.0.0, ::,
// or an empty host), the case where a specific-address listener elsewhere
// blocks our bind.
func isWildcardHost(host string) bool {
	if host == "" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsUnspecified()
}

// sweepOrphans removes preview checkouts left behind by a previous daemon run
// (crash or unclean shutdown). Called once per project before the first slot is
// created, so nothing here can belong to a live instance.
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

// Run drives the reaper until ctx is done: idle servers are torn down, slots
// whose live worktree vanished (head killed/merged via any path) are removed
// entirely, and branch-tip slots rebuild+hot-swap when their tip moves. Call as
// a goroutine.
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

// reap applies the periodic lifecycle rules to every slot.
func (m *Manager) reap() {
	m.mu.Lock()
	all := make([]*slot, 0, len(m.slots))
	for _, s := range m.slots {
		all = append(all, s)
	}
	m.mu.Unlock()

	now := time.Now()
	for _, s := range all {
		s.mu.Lock()
		active := s.active
		s.mu.Unlock()

		// A head's worktree was removed: the slot is unservable, remove it.
		if active != nil && active.version.WorktreeDir != "" {
			if _, err := os.Stat(active.version.WorktreeDir); err != nil {
				m.removeSlot(s)
				continue
			}
		}

		if active != nil {
			active.mu.Lock()
			state := active.state
			idleFor := now.Sub(active.lastActive)
			inflight := active.inflight
			idleTimeout := active.idleTimeout()
			active.mu.Unlock()
			if (state == StateRunning || state == StateStarting) && inflight == 0 && idleFor > idleTimeout {
				active.stopChild(StateStopped, "")
				// A background hot-swap build nobody is watching is pointless.
				s.mu.Lock()
				p := s.pending
				s.pending = nil
				s.mu.Unlock()
				if p != nil {
					go p.teardown()
				}
				continue
			}
		}

		// Branch-tip slots follow their tip in the background.
		s.followTip()
	}
}
