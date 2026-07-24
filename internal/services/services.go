// Package services supervises per-project long-running commands declared as
// [[services]] in a project's config. A service is started while its project is
// registered with the daemon, relaunched with capped backoff if it exits
// unexpectedly, and process-group-killed on daemon shutdown, project removal, or
// a config save. The canonical use is a host-side resource pool (e.g. a pool of
// Android emulators) shared by every head of the project - work the per-head
// sandbox cannot do because it lacks host devices like /dev/kvm.
package services

import (
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// State is the lifecycle state of a supervised service, surfaced to the UI.
type State string

// Note: the string values are deliberately distinct from AgentStatus's values
// ("running"/"stopped") so the two status enums don't collide in the generated
// API client (a value collision makes oapi-codegen prefix every enum constant).
const (
	// StateRunning means the process is currently up.
	StateRunning State = "up"
	// StateRestarting means the process exited and is backing off before relaunch.
	StateRestarting State = "restarting"
	// StateFailed means the process exhausted its restart budget (or failed to
	// even start) and the supervisor gave up.
	StateFailed State = "failed"
	// StateStopped means the service was intentionally stopped (shutdown / removal).
	StateStopped State = "down"
	// StatePaused means the service is intentionally not running because its
	// project currently has no active agents (the activity gate). It restarts
	// automatically once an agent is spawned.
	StatePaused State = "paused"
)

// pausedMessage explains a StatePaused service in the UI.
const pausedMessage = "No active agents in this project - services start when an agent is spawned."

// Status is a snapshot of one supervised service for the API/UI.
type Status struct {
	Name        string `json:"name"`
	Command     string `json:"command"`
	Host        bool   `json:"host"`
	State       State  `json:"state"`
	Restarts    int    `json:"restarts"`
	MaxRestarts int    `json:"max_restarts"`
	PID         int    `json:"pid"`
	// Message is a human-readable detail for non-running states (exit reason,
	// last output line, or start error).
	Message string `json:"message"`
}

// supervised holds the live state of one service.
type supervised struct {
	spec config.ServiceScript
	sink *lineSink
	// onChange, if set, is called (outside the lock) whenever a set() actually
	// changes the service's State, so the manager can push a services_changed event.
	onChange func()

	mu     sync.Mutex
	status Status
}

func (s *supervised) snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// reset returns the service to a fresh running status ahead of a (re)launch,
// clearing the restart counter and any prior failure/pause message.
func (s *supervised) reset() {
	s.set(func(st *Status) {
		st.State = StateRunning
		st.PID = 0
		st.Restarts = 0
		st.Message = ""
	})
}

// pause marks the service paused by the activity gate (project has no agents).
func (s *supervised) pause() {
	s.set(func(st *Status) {
		st.State = StatePaused
		st.PID = 0
		st.Message = pausedMessage
	})
}

func (s *supervised) set(mut func(*Status)) {
	s.mu.Lock()
	before := s.status.State
	mut(&s.status)
	changed := s.status.State != before
	s.mu.Unlock()
	// Notify only on a genuine State transition (set() also churns PID/message),
	// and outside the lock so the callback can publish without contending.
	if changed && s.onChange != nil {
		s.onChange()
	}
}

// projectServices is the set of supervisors for one registered project. The
// supervised list is built once at registration and reused across start/pause
// cycles so Status stays well-defined while the activity gate parks the project.
// All lifecycle fields are guarded by mu, held across the (blocking) teardown in
// stopRunLocked so a project's transitions serialize without contending across
// projects.
type projectServices struct {
	mu      sync.Mutex
	svcs    []*supervised
	running bool
	closed  bool               // unregistered (StopProject); never (re)launch again
	cancel  context.CancelFunc // cancels the current run's supervisors; nil when down
	wg      sync.WaitGroup

	// idleSince is when the project last had zero active agents; the zero value
	// means it currently has agents (or the gate hasn't observed it idle yet).
	// The project is paused once it has been idle for the Manager's idleTimeout.
	idleSince time.Time
}

// Manager owns the supervisors for every registered project. It is safe for
// concurrent use.
type Manager struct {
	mu       sync.Mutex
	projects map[string]*projectServices

	// onChange, if set, is invoked with the project root whenever a supervised
	// service's State transitions, so the daemon can push a services_changed event.
	// Set once at startup before any project is supervised (see SetOnChange).
	onChange func(root string)

	// activityProbe, if set, returns the number of active agents in a project.
	// When set, services are gated on activity: a project runs its services only
	// while it has >=1 agent, pausing them idleTimeout after the last one is
	// removed and relaunching them when an agent appears. When nil, services run
	// for the whole time a project is registered (the ungated legacy behaviour).
	// Set once before StartProject (see SetActivityProbe).
	activityProbe func(root string) int

	// Timing knobs (overridable in tests).
	initialBackoff  time.Duration
	maxBackoff      time.Duration
	stableThreshold time.Duration // run longer than this and the restart counter resets
	stopGrace       time.Duration // SIGTERM -> SIGKILL window on stop
	idleTimeout     time.Duration // no-agent grace before pausing a project's services
	gateInterval    time.Duration // activity-gate reconciler tick
}

// SetOnChange registers a callback invoked (with the project root) whenever a
// supervised service's State changes. Call it once before StartProject; it is not
// safe to change while services are running.
func (m *Manager) SetOnChange(fn func(root string)) { m.onChange = fn }

// SetActivityProbe enables activity gating: fn returns the current number of
// active agents in a project, and services run only while a project has agents
// (see the activityProbe field). Call it once before StartProject and before
// RunActivityGate; it is not safe to change while services are running.
func (m *Manager) SetActivityProbe(fn func(root string) int) { m.activityProbe = fn }

// NewManager returns a Manager with production timing defaults.
func NewManager() *Manager {
	return &Manager{
		projects:        map[string]*projectServices{},
		initialBackoff:  1 * time.Second,
		maxBackoff:      30 * time.Second,
		stableThreshold: 10 * time.Second,
		stopGrace:       5 * time.Second,
		idleTimeout:     60 * time.Second,
		gateInterval:    5 * time.Second,
	}
}

// normalize resolves a project root to its canonical form so Start/Stop/Status
// agree on the map key regardless of the caller's path spelling.
func normalize(root string) string {
	if n, err := paths.NormalizePath(root); err == nil {
		return n
	}
	return root
}

// StartProject loads the project's config and registers a supervisor per service.
// It is idempotent: a project already registered is left untouched (call
// RestartProject to pick up config changes). A project with no services records
// an empty entry so Status is well-defined.
//
// Whether the services actually launch now depends on the activity gate: with a
// probe set (see SetActivityProbe) a project with no active agents is registered
// in the paused state and its services start only once an agent appears; without
// a probe they launch immediately.
func (m *Manager) StartProject(root string) {
	root = normalize(root)

	cfg, err := config.Load(root)
	if err != nil {
		log.Printf("services: load config for %s: %v", root, err)
		return
	}

	m.mu.Lock()
	if _, ok := m.projects[root]; ok {
		m.mu.Unlock()
		return // already registered
	}
	ps := &projectServices{}
	for _, spec := range cfg.Services {
		if strings.TrimSpace(spec.Command) == "" {
			continue
		}
		if !spec.IsEnabled() {
			continue // explicitly disabled in config
		}
		sv := &supervised{
			spec: spec,
			sink: &lineSink{prefix: "service[" + shortName(root) + "/" + spec.Name + "]:"},
			onChange: func() {
				if m.onChange != nil {
					m.onChange(root)
				}
			},
			status: Status{
				Name:        spec.Name,
				Command:     spec.Command,
				Host:        spec.Host,
				State:       StateRunning,
				MaxRestarts: maxRestarts(spec),
			},
		}
		ps.svcs = append(ps.svcs, sv)
	}
	m.projects[root] = ps
	m.mu.Unlock()

	if len(ps.svcs) == 0 {
		return
	}

	// Activity gate: hold the project paused if it has no active agents yet, so a
	// freshly-added (or freshly-booted) project doesn't spin up services nobody is
	// using. The reconciler (RunActivityGate) flips it to running when one appears.
	if m.activityProbe != nil && m.activityProbe(root) == 0 {
		ps.mu.Lock()
		ps.idleSince = time.Now()
		m.pauseServices(ps)
		ps.mu.Unlock()
		log.Printf("services: %d service(s) for %s paused (no active agents)", len(ps.svcs), root)
		return
	}

	ps.mu.Lock()
	m.startRunLocked(root, ps)
	ps.mu.Unlock()
}

// startRunLocked launches a supervise goroutine for each of the project's
// services and marks it running. Caller holds ps.mu; a no-op if already running.
func (m *Manager) startRunLocked(root string, ps *projectServices) {
	if ps.running || ps.closed || len(ps.svcs) == 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	ps.cancel = cancel
	ps.running = true
	for _, sv := range ps.svcs {
		sv.reset()
		ps.wg.Add(1)
		go m.supervise(ctx, root, ps, sv)
	}
	log.Printf("services: started %d service(s) for %s", len(ps.svcs), root)
}

// stopRunLocked cancels the current run, waits for the supervisors to exit, and
// settles every service into rest (StatePaused for the activity gate, else
// StateStopped). Caller holds ps.mu; a no-op if not running.
func (m *Manager) stopRunLocked(ps *projectServices, rest State) {
	if !ps.running {
		return
	}
	ps.cancel()
	ps.running = false
	ps.cancel = nil
	ps.wg.Wait()
	// supervise() sets StateStopped when it observes the cancel; override to the
	// intended resting state so a paused project reads as paused, not "down".
	for _, sv := range ps.svcs {
		if rest == StatePaused {
			sv.pause()
		} else {
			sv.set(func(s *Status) { s.State = rest; s.PID = 0 })
		}
	}
}

// pauseServices marks every (currently-down) service paused. Caller holds ps.mu.
// Used when a project is registered while already idle, so it never launched.
func (m *Manager) pauseServices(ps *projectServices) {
	for _, sv := range ps.svcs {
		sv.pause()
	}
}

// StopProject stops and forgets all supervisors for a project. Safe to call for
// an unknown project (no-op).
func (m *Manager) StopProject(root string) {
	root = normalize(root)
	m.mu.Lock()
	ps := m.projects[root]
	delete(m.projects, root)
	m.mu.Unlock()
	if ps == nil {
		return
	}
	ps.mu.Lock()
	ps.closed = true // a concurrent gate reconcile must not relaunch it
	m.stopRunLocked(ps, StateStopped)
	ps.mu.Unlock()
	log.Printf("services: stopped service(s) for %s", root)
}

// RestartProject stops then re-starts a project's services, picking up any
// config changes. Used after a config save and for the manual restart control.
func (m *Manager) RestartProject(root string) {
	m.StopProject(root)
	m.StartProject(root)
}

// StopAll stops every project's services (daemon shutdown). Projects are stopped
// concurrently so one slow teardown doesn't serialize the rest.
func (m *Manager) StopAll() {
	m.mu.Lock()
	roots := make([]string, 0, len(m.projects))
	for root := range m.projects {
		roots = append(roots, root)
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, root := range roots {
		wg.Add(1)
		go func(r string) {
			defer wg.Done()
			m.StopProject(r)
		}(root)
	}
	wg.Wait()
}

// RunActivityGate periodically reconciles every registered project's services
// against its active-agent count until ctx is cancelled: it launches a paused
// project's services once it has an agent, and pauses a running project's
// services once it has been idle (no agents) for idleTimeout. It is a no-op when
// no activity probe is set. Run it in its own goroutine after SetActivityProbe.
func (m *Manager) RunActivityGate(ctx context.Context) {
	if m.activityProbe == nil {
		return
	}
	t := time.NewTicker(m.gateInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.mu.Lock()
			roots := make([]string, 0, len(m.projects))
			pss := make([]*projectServices, 0, len(m.projects))
			for root, ps := range m.projects {
				roots = append(roots, root)
				pss = append(pss, ps)
			}
			m.mu.Unlock()
			for i := range roots {
				m.reconcileProject(roots[i], pss[i])
			}
		}
	}
}

// reconcileProject applies the activity gate to one registered project: start
// its services when it has agents, pause them once it has been idle past the
// timeout. The agent count is read before taking ps.mu so the (possibly slow)
// probe never blocks another project's transition.
func (m *Manager) reconcileProject(root string, ps *projectServices) {
	if len(ps.svcs) == 0 {
		return
	}
	count := m.activityProbe(root)

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if count > 0 {
		ps.idleSince = time.Time{}
		if !ps.running {
			m.startRunLocked(root, ps)
		}
		return
	}
	// No agents: start (or continue) the idle clock, and pause once it elapses.
	if ps.idleSince.IsZero() {
		ps.idleSince = time.Now()
	}
	if ps.running && time.Since(ps.idleSince) >= m.idleTimeout {
		m.stopRunLocked(ps, StatePaused)
		log.Printf("services: paused service(s) for %s (idle %s with no agents)", root, m.idleTimeout)
	}
}

// Status returns a snapshot of the services for a project (nil if unknown).
func (m *Manager) Status(root string) []Status {
	root = normalize(root)
	m.mu.Lock()
	ps := m.projects[root]
	m.mu.Unlock()
	if ps == nil {
		return nil
	}
	out := make([]Status, 0, len(ps.svcs))
	for _, sv := range ps.svcs {
		out = append(out, sv.snapshot())
	}
	return out
}

// supervise runs one service: launch, wait, and relaunch with capped backoff on
// unexpected exit until the restart budget is spent or the context is cancelled.
func (m *Manager) supervise(ctx context.Context, root string, ps *projectServices, sv *supervised) {
	defer ps.wg.Done()

	max := maxRestarts(sv.spec)
	restarts := 0
	backoff := m.initialBackoff

	for {
		if ctx.Err() != nil {
			sv.set(func(s *Status) { s.State = StateStopped; s.PID = 0 })
			return
		}

		cmd, cleanup, err := m.buildCmd(ctx, root, sv)
		if err != nil {
			// Could not even build the launch (e.g. sandbox unavailable). Treat as
			// a start failure subject to the same restart budget.
			sv.set(func(s *Status) {
				s.State = StateFailed
				s.Message = "build launch: " + err.Error()
				s.PID = 0
			})
			log.Printf("services: %s/%s: build launch: %v", shortName(root), sv.spec.Name, err)
			return
		}

		startedAt := time.Now()
		startErr := cmd.Start()
		if startErr == nil {
			pid := cmd.Process.Pid
			sv.set(func(s *Status) {
				s.State = StateRunning
				s.PID = pid
				s.Restarts = restarts
				s.Message = ""
			})

			// Terminate the whole process group when the context is cancelled, so
			// a supervisor (e.g. emu-pool.sh) takes its children down with it.
			done := make(chan struct{})
			go func() {
				select {
				case <-ctx.Done():
					terminateGroup(pid)
					// Also stop the systemd scope: when the service is scoped the
					// tracked pid is systemd-run's, so the process-group signal may
					// not reach the sandboxed children - StopScope reaps the cgroup.
					sandbox.StopScope(serviceScopeUnit(root, sv))
					select {
					case <-done:
					case <-time.After(m.stopGrace):
						killGroup(pid)
					}
				case <-done:
				}
			}()
			waitErr := cmd.Wait()
			close(done)
			cleanup()

			if ctx.Err() != nil {
				sv.set(func(s *Status) { s.State = StateStopped; s.PID = 0 })
				return
			}
			// Unexpected exit. Reset the budget if it had been stable for a while.
			if time.Since(startedAt) > m.stableThreshold {
				restarts = 0
				backoff = m.initialBackoff
			}
			startErr = waitErr // fall through to the restart decision
		} else {
			cleanup()
		}

		reason := "exited"
		if startErr != nil {
			reason = startErr.Error()
		}
		if last := sv.sink.LastLine(); last != "" {
			reason += " (last output: " + last + ")"
		}

		if restarts >= max {
			r := reason
			sv.set(func(s *Status) {
				s.State = StateFailed
				s.PID = 0
				s.Restarts = restarts
				s.Message = r
			})
			log.Printf("services: %s/%s failed after %d restart(s): %s", shortName(root), sv.spec.Name, restarts, reason)
			return
		}
		restarts++
		r := reason
		n := restarts
		sv.set(func(s *Status) {
			s.State = StateRestarting
			s.PID = 0
			s.Restarts = n
			s.Message = r
		})
		log.Printf("services: %s/%s exited (%s); restart %d/%d in %s", shortName(root), sv.spec.Name, reason, restarts, max, backoff)

		select {
		case <-ctx.Done():
			sv.set(func(s *Status) { s.State = StateStopped; s.PID = 0 })
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > m.maxBackoff {
			backoff = m.maxBackoff
		}
	}
}

// serviceScopeUnit is the transient systemd scope unit name for a service. It is
// a pure function of (project root, service name) so both the spawn and teardown
// paths can derive it without extra plumbing; the root hash keeps units unique
// across projects that share a service name (one daemon serves them all).
func serviceScopeUnit(root string, sv *supervised) string {
	return sandbox.ScopeUnit("service", sv.spec.Name+"-"+sandbox.ScopeHash(root))
}

// buildCmd constructs the exec.Cmd for a service launch plus a cleanup func that
// releases any sandbox temp resources. The command runs from the project root,
// directly on the host when spec.Host is set, otherwise inside the OS sandbox.
func (m *Manager) buildCmd(ctx context.Context, root string, sv *supervised) (*exec.Cmd, func(), error) {
	home, _ := os.UserHomeDir()
	env := append([]string{}, os.Environ()...)
	if home != "" {
		env = append(env, "HOME="+home)
	}
	env = append(env,
		"HYDRA_PROJECT_ROOT="+root,
		"HYDRA_SERVICE_NAME="+sv.spec.Name,
	)
	env = append(env, sandbox.MiseTrustEnv(root, root)...)

	command := sv.spec.Command
	if sv.spec.IsStrict() {
		// Fail-fast: a service that fails its setup mid-script must surface as a
		// crash (and restart) rather than a healthy process (strict = false opts out).
		command = sandbox.StrictScript(sv.spec.Command)
	}
	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash,
		WorktreePath: root, // services run against the live project root
		Home:         home,
		Env:          env,
		Argv:         []string{"bash", "-c", command},
		NoSandbox:    sv.spec.Host,
	}
	var egressSess *egress.Session
	if !sv.spec.Host {
		cfg, _ := config.Load(root)
		writable, masked, restore, _, netPol, _ := cfg.ResolveSandboxOptions("")
		if gcd, err := git.GetCommonDir(root); err == nil {
			opts.GitCommonDir = gcd
		}
		opts.WritablePaths = writable
		opts.MaskedPaths = masked
		opts.RestoreRO = restore
		// Sandboxed services honor the project's network mode like agent heads do
		// (hard = pasta netns + nft + CONNECT proxy); the session lives as long as
		// the service process (closed via the returned cleanup). Unknown hosts are
		// silently denied - a supervised service has no approval UI.
		egressSess = egress.StartCommandEgress("service:"+sv.spec.Name, sandbox.AgentTypeBash, &netPol, 0, nil)
		opts.Env = append(opts.Env, egressSess.Env...)
		opts.EgressWrap = egressSess.Wrap
		opts.Network = netPol
		opts.HardenGUI = true
		opts.Seccomp = true
	}

	spec, err := sandbox.BuildSpec(opts)
	if err != nil {
		egressSess.Close()
		return nil, func() {}, errtrace.Wrap(err)
	}

	// Run the service under a transient systemd scope (best-effort) so its
	// process subtree gets its own cgroup with CPU/IO weight limits and a single
	// kill handle, and can't outlive the daemon. Reaped in the ctx.Done path below.
	sandbox.WrapScope(serviceScopeUnit(root, sv), spec)

	cmd := exec.CommandContext(ctx, spec.Path, spec.Args[1:]...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.ExtraFiles = spec.ExtraFiles
	cmd.Stdout = sv.sink
	cmd.Stderr = sv.sink
	// On unix this sets a process group and disables the default CommandContext
	// killer so our done-goroutine can signal the whole group on ctx cancel; on
	// other platforms it's a no-op and the default leader-kill stays in effect.
	configureProc(cmd)
	cleanup := func() {
		if spec.Cleanup != nil {
			spec.Cleanup()
		}
		egressSess.Close()
	}
	return cmd, cleanup, nil
}

// maxRestarts resolves the restart cap for a service (default when unset).
func maxRestarts(spec config.ServiceScript) int {
	if spec.MaxRestarts != nil {
		if *spec.MaxRestarts < 0 {
			return 0
		}
		return *spec.MaxRestarts
	}
	return config.DefaultServiceMaxRestarts
}

// shortName returns the last path element of a project root, for log prefixes.
func shortName(root string) string {
	if i := strings.LastIndexAny(root, "/\\"); i >= 0 && i+1 < len(root) {
		return root[i+1:]
	}
	return root
}

// lineSink is an io.Writer that logs each complete line with a prefix and
// remembers the most recent non-blank line (for failure diagnostics). os/exec
// serializes writes when the same sink is used for both stdout and stderr.
type lineSink struct {
	prefix  string
	mu      sync.Mutex
	last    string
	partial []byte
}

func (s *lineSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.partial = append(s.partial, p...)
	for {
		i := bytes.IndexByte(s.partial, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(s.partial[:i]), "\r")
		s.partial = append([]byte{}, s.partial[i+1:]...)
		if strings.TrimSpace(line) != "" {
			s.last = line
			log.Printf("%s %s", s.prefix, line)
		}
	}
	return len(p), nil
}

func (s *lineSink) LastLine() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}
