// Package services supervises per-project long-running commands declared as
// [[services]] in a project's config. A service is started while its project is
// registered with the daemon, relaunched with capped backoff if it exits
// unexpectedly, and process-group-killed on daemon shutdown, project removal, or
// a config save. The canonical use is a host-side resource pool (e.g. a pool of
// Android emulators) shared by every head of the project — work the per-head
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
)

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

	mu     sync.Mutex
	status Status
}

func (s *supervised) snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *supervised) set(mut func(*Status)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mut(&s.status)
}

// projectServices is the set of supervisors for one registered project.
type projectServices struct {
	cancel context.CancelFunc
	wg     sync.WaitGroup
	svcs   []*supervised
}

// Manager owns the supervisors for every registered project. It is safe for
// concurrent use.
type Manager struct {
	mu       sync.Mutex
	projects map[string]*projectServices

	// Timing knobs (overridable in tests).
	initialBackoff  time.Duration
	maxBackoff      time.Duration
	stableThreshold time.Duration // run longer than this and the restart counter resets
	stopGrace       time.Duration // SIGTERM -> SIGKILL window on stop
}

// NewManager returns a Manager with production timing defaults.
func NewManager() *Manager {
	return &Manager{
		projects:        map[string]*projectServices{},
		initialBackoff:  1 * time.Second,
		maxBackoff:      30 * time.Second,
		stableThreshold: 10 * time.Second,
		stopGrace:       5 * time.Second,
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

// StartProject loads the project's config and starts a supervisor per service.
// It is idempotent: a project already running is left untouched (call
// RestartProject to pick up config changes). A project with no services records
// an empty entry so Status is well-defined.
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
		return // already supervised
	}
	ctx, cancel := context.WithCancel(context.Background())
	ps := &projectServices{cancel: cancel}
	for _, spec := range cfg.Services {
		if strings.TrimSpace(spec.Command) == "" {
			continue
		}
		sv := &supervised{
			spec: spec,
			sink: &lineSink{prefix: "service[" + shortName(root) + "/" + spec.Name + "]:"},
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

	for _, sv := range ps.svcs {
		ps.wg.Add(1)
		go m.supervise(ctx, root, ps, sv)
	}
	if n := len(ps.svcs); n > 0 {
		log.Printf("services: started %d service(s) for %s", n, root)
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
	ps.cancel()
	ps.wg.Wait()
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

	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash,
		WorktreePath: root, // services run against the live project root
		Home:         home,
		Env:          env,
		Argv:         []string{"bash", "-c", sv.spec.Command},
		NoSandbox:    sv.spec.Host,
	}
	if !sv.spec.Host {
		cfg, _ := config.Load(root)
		writable, masked, restore, _, _, _ := cfg.ResolveSandboxOptions("")
		if gcd, err := git.GetCommonDir(root); err == nil {
			opts.GitCommonDir = gcd
		}
		opts.WritablePaths = writable
		opts.MaskedPaths = masked
		opts.RestoreRO = restore
		opts.Network = sandbox.NetworkPolicy{Enabled: true}
		opts.HardenGUI = true
		opts.Seccomp = true
	}

	spec, err := sandbox.BuildSpec(opts)
	if err != nil {
		return nil, func() {}, errtrace.Wrap(err)
	}

	cmd := exec.CommandContext(ctx, spec.Path, spec.Args[1:]...) //errtrace:skip
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.ExtraFiles = spec.ExtraFiles
	cmd.Stdout = sv.sink
	cmd.Stderr = sv.sink
	// On unix this sets a process group and disables the default CommandContext
	// killer so our done-goroutine can signal the whole group on ctx cancel; on
	// other platforms it's a no-op and the default leader-kill stays in effect.
	configureProc(cmd)
	return cmd, spec.Cleanup, nil
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
