package preview

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/scope"
)

// instance is one backing server for a slot: an on-demand child server process
// running a specific checkout (worktree, or an ephemeral commit checkout). The
// slot owns the proxy listener/port and forwards requests to whichever instance
// is currently its front (see slot.serveHTTP); an instance never binds a
// listener of its own, so it can be spawned in the background and hot-swapped in.
type instance struct {
	mgr *Manager

	// Immutable after creation.
	root         string
	version      Version
	runDir       string
	ownsCheckout bool
	channel      string // the slot channel this instance serves (see Version.channelID)
	// syncFrom/syncBaseSHA drive the "Latest changes" worktree channel: the
	// server runs in runDir (an own checkout at syncBaseSHA) while a background
	// loop mirrors the live worktree's changes in. Empty for commit/tip channels.
	syncFrom    string
	syncBaseSHA string

	mu        sync.Mutex
	spec      config.PreviewScript
	state     State
	childPort int
	pid       int
	scopeUnit string // transient systemd scope wrapping this run's sandbox, if any
	cancel    context.CancelFunc
	// gen increments on every spawn and on stopChild; a run goroutine settles
	// its instance state only while its captured gen is current, so a
	// superseded lifetime can never clobber a newer one.
	gen int
	// readyCh is non-nil exactly while state == StateStarting and is closed
	// (once) on every transition out of it; waiters that grabbed it earlier
	// read the closed channel and re-check state.
	readyCh    chan struct{}
	proxy      *httputil.ReverseProxy
	log        []LogLine // ring, newest last, capped at logRingSize
	progress   string
	message    string // error detail for StateError
	startedAt  time.Time
	inflight   int
	lastActive time.Time
	// baseFingerprint is the mirrored worktree state this run was built from;
	// stale latches true once the live worktree diverges from it (worktree
	// channel only). Both reset at the start of each run.
	baseFingerprint string
	stale           bool
}

// idleTimeout returns the effective idle teardown duration. Caller holds mu.
func (in *instance) idleTimeout() time.Duration {
	if in.spec.IdleTimeoutSec > 0 {
		return time.Duration(in.spec.IdleTimeoutSec) * time.Second
	}
	return in.mgr.idleDefault
}

// readyTimeout returns the effective spawn-to-ready deadline. Caller holds mu.
func (in *instance) readyTimeout() time.Duration {
	if in.spec.ReadyTimeoutSec > 0 {
		return time.Duration(in.spec.ReadyTimeoutSec) * time.Second
	}
	return in.mgr.readyDefault
}

// touch records user-visible activity, deferring idle teardown.
func (in *instance) touch() {
	in.mu.Lock()
	in.lastActive = time.Now()
	in.mu.Unlock()
}

// status snapshots the instance for the API. Port is left 0; the slot fills in
// its own proxy port (the instance owns no listener).
func (in *instance) status() Status {
	in.mu.Lock()
	defer in.mu.Unlock()
	return Status{
		Name:      in.spec.Name,
		State:     in.state,
		Version:   in.version.Label(),
		Pid:       in.pid,
		Inflight:  in.inflight,
		StartedAt: in.startedAt,
		Progress:  in.progress,
		Message:   in.message,
		Stale:     in.stale,
		Log:       append([]LogLine(nil), in.log...),
	}
}

// setSpec adopts a possibly-updated spec (timeouts, command) for future spawns.
func (in *instance) setSpec(spec config.PreviewScript) {
	in.mu.Lock()
	in.spec = spec
	in.mu.Unlock()
}

// appendLog adds a line to the bounded log ring and captures markers. Caller
// must NOT hold mu.
func (in *instance) appendLog(line, stream string) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if progress, ok := strings.CutPrefix(line, ProgressMarker); ok {
		in.progress = strings.TrimSpace(progress)
		line = in.progress
	}
	in.log = append(in.log, LogLine{Text: line, Stream: stream})
	if len(in.log) > logRingSize {
		in.log = in.log[len(in.log)-logRingSize:]
	}
}

// ensureStarted spawns the child unless it is already starting or running.
func (in *instance) ensureStarted() {
	in.mu.Lock()
	if in.state == StateStarting || in.state == StateRunning {
		in.mu.Unlock()
		return
	}
	// Reset for a fresh spawn.
	in.state = StateStarting
	in.log = nil
	in.progress = ""
	in.message = ""
	in.startedAt = time.Now()
	in.lastActive = time.Now()
	in.gen++
	gen := in.gen
	readyCh := make(chan struct{})
	in.readyCh = readyCh
	ctx, cancel := context.WithCancel(context.Background())
	in.cancel = cancel
	spec := in.spec
	in.mu.Unlock()

	go in.run(ctx, cancel, spec, gen, readyCh)
}

// run executes one child lifetime: allocate the child port, build the
// (sandboxed) command, wait for readiness, and settle the state when the
// process exits. It owns the transitions out of StateStarting while gen is
// current; stopChild supersedes it by bumping gen.
func (in *instance) run(ctx context.Context, cancel context.CancelFunc, spec config.PreviewScript, gen int, readyCh chan struct{}) {
	defer cancel()

	// Worktree channel: bring the own-checkout current with the live worktree
	// before the build starts, and record the fingerprint this run builds from
	// (clearing any stale flag left by a previous run).
	if in.syncFrom != "" {
		if fp, err := mirrorWorktree(in.syncFrom, in.runDir, in.syncBaseSHA); err == nil {
			in.mu.Lock()
			in.baseFingerprint = fp
			in.stale = false
			in.mu.Unlock()
		}
	}

	childPort, err := freePort()
	if err != nil {
		in.settleError(gen, fmt.Sprintf("allocate child port: %v", err))
		return
	}
	launch, hardMode, err := in.buildSpec(spec, childPort)
	if err != nil {
		in.settleError(gen, fmt.Sprintf("build sandbox spec: %v", err))
		return
	}
	defer launch.Cleanup()

	// Run under a transient systemd scope (best-effort): own cgroup with CPU/IO
	// weight limits + a single kill handle, reaped in stopChild. The child port
	// makes the unit unique among concurrently-live preview instances (active +
	// pending of the same script/head), so pre-clearing a stale unit can't kill a
	// sibling's scope.
	scopeUnit := sandbox.ScopeUnit("preview", spec.Name+"-"+in.version.HeadID+"-"+strconv.Itoa(childPort))
	scope.Apply(in.root, scopeUnit, launch, sandbox.ScopeInteractive)

	cmd := scope.Command(ctx, launch)
	configureProc(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		in.settleError(gen, err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		in.settleError(gen, err.Error())
		return
	}
	if err := scope.Start(cmd); err != nil {
		in.settleError(gen, err.Error())
		return
	}

	markReady := func() {
		in.mu.Lock()
		if in.gen == gen && in.state == StateStarting {
			in.state = StateRunning
			in.childPort = childPort
			target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", childPort))}
			proxy := httputil.NewSingleHostReverseProxy(target)
			proxy.ModifyResponse = forceRevalidate
			in.proxy = proxy
			close(readyCh)
			in.readyCh = nil
		}
		in.mu.Unlock()
	}

	in.mu.Lock()
	if in.gen != gen {
		// A concurrent stop already superseded this spawn.
		in.mu.Unlock()
		terminateGroup(cmd.Process.Pid)
		sandbox.StopScope(scopeUnit)
		_ = cmd.Wait()
		return
	}
	in.pid = cmd.Process.Pid
	in.scopeUnit = scopeUnit
	readyDeadline := in.readyTimeout()
	in.mu.Unlock()

	// Worktree channel: mirror the live worktree's changes into the checkout
	// while the server runs (only while it runs - ctx is cancelled on exit).
	if in.syncFrom != "" {
		go in.syncLoop(ctx)
	}

	var wg sync.WaitGroup
	scan := func(r io.Reader, stream string) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			if strings.HasPrefix(line, ReadyMarker) {
				markReady()
				continue
			}
			in.appendLog(line, stream)
		}
	}
	wg.Add(2)
	go scan(stdout, "stdout")
	go scan(stderr, "stderr")

	// Readiness prober: send a real HTTP GET to the child port until it
	// answers (or the ready deadline / process exit cancels us). A bare TCP
	// dial can't be trusted under hard mode - pasta holds the host port and
	// completes the handshake itself even when nothing inside the netns is
	// listening, so a dial would false-positive and every proxied request
	// would then 502. Any HTTP response (even 404/500) proves the child is up.
	probeCtx, probeCancel := context.WithTimeout(ctx, readyDeadline)
	go func() {
		defer probeCancel()
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		addr := net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", childPort))
		client := &http.Client{
			Timeout:   2 * time.Second,
			Transport: &http.Transport{DisableKeepAlives: true},
		}
		for {
			select {
			case <-probeCtx.Done():
				return
			case <-t.C:
				req, _ := http.NewRequestWithContext(probeCtx, http.MethodGet, "http://"+addr+"/", nil)
				resp, err := client.Do(req)
				if err == nil {
					_ = resp.Body.Close()
					markReady()
					return
				}
				// No bind-address hint here: under hard mode pasta holds the
				// host port and completes TCP handshakes even while nothing
				// inside the netns listens, so during a long build "dial ok,
				// HTTP dead" is the NORMAL starting state and a mid-probe
				// warning fires spuriously on every spawn. The hint is
				// attached to the ready-deadline failure below instead, the
				// point where it is actually diagnostic.
			}
		}
	}()

	// Ready-deadline watchdog: a spawn that never becomes ready is killed and
	// reported, rather than building forever with nobody watching.
	go func() {
		<-probeCtx.Done()
		in.mu.Lock()
		expired := in.gen == gen && in.state == StateStarting && probeCtx.Err() == context.DeadlineExceeded
		in.mu.Unlock()
		if expired {
			in.appendLog(fmt.Sprintf("hydra: server not ready after %s, giving up", readyDeadline), "stderr")
			if hardMode {
				// The likeliest config mistake behind never-ready under hard
				// mode: the server bound loopback INSIDE the netns, where
				// pasta's inbound forward can't reach it. (A raw dial can't
				// distinguish this - pasta ACKs regardless - hence a hint at
				// give-up time rather than a check during startup.)
				in.appendLog("hydra: if the server was listening, check its bind address - under network mode hard it must bind 0.0.0.0 (use HYDRA_PREVIEW_ADDR), not 127.0.0.1", "stderr")
			}
			terminateGroup(cmd.Process.Pid)
		}
	}()

	wg.Wait()
	err = cmd.Wait()
	probeCancel()

	// Settle: whatever state we were in, the child is gone now.
	in.mu.Lock()
	if in.gen != gen {
		in.mu.Unlock()
		return // superseded by stopChild / a newer spawn
	}
	wasStarting := in.state == StateStarting
	in.pid = 0
	in.childPort = 0
	in.proxy = nil
	if wasStarting {
		in.state = StateError
		in.message = firstNonEmpty(exitMessage(err), "server exited before becoming ready")
		close(readyCh)
		in.readyCh = nil
	} else {
		// A running server that exits on its own (crash or clean exit) goes back
		// to stopped; the next request respawns it.
		in.state = StateStopped
		in.message = ""
	}
	in.cancel = nil
	in.mu.Unlock()
}

// settleError moves a failed spawn to StateError before the child ever ran.
func (in *instance) settleError(gen int, msg string) {
	in.mu.Lock()
	if in.gen == gen && in.state == StateStarting {
		in.state = StateError
		in.message = msg
		close(in.readyCh)
		in.readyCh = nil
		in.cancel = nil
	}
	in.mu.Unlock()
}

// stopChild kills the child process group (if any) and settles the instance
// into finalState. The listener and instance survive for a later respawn.
func (in *instance) stopChild(finalState State, message string) {
	in.mu.Lock()
	pid := in.pid
	scopeUnit := in.scopeUnit
	cancel := in.cancel
	in.gen++ // supersede the live run goroutine, if any
	if in.state == StateStarting && in.readyCh != nil {
		// Unblock waiters; they re-check state and see stopped/error.
		close(in.readyCh)
	}
	in.state = finalState
	in.message = message
	in.pid = 0
	in.scopeUnit = ""
	in.childPort = 0
	in.proxy = nil
	in.readyCh = nil
	in.cancel = nil
	in.mu.Unlock()

	if pid > 0 {
		terminateGroup(pid)
		// Also reap the systemd scope: when scoped, the tracked pid is
		// systemd-run's, so the process-group signal may not reach the sandboxed
		// children - StopScope tears down the whole cgroup.
		sandbox.StopScope(scopeUnit)
		grace := in.mgr.stopGrace
		go func() {
			time.Sleep(grace)
			killGroup(pid)
		}()
	}
	if cancel != nil {
		cancel()
	}
}

// teardown fully disposes of the instance: child killed and, for a commit-style
// instance, its ephemeral checkout deleted. The slot owns the listener, so
// nothing is closed here. The instance must already be detached from its slot.
func (in *instance) teardown() {
	in.stopChild(StateStopped, "")
	if in.ownsCheckout {
		_ = git.RemoveWorktree(in.root, in.runDir)
		_ = os.RemoveAll(in.runDir)
	}
}

// buildSpec constructs the (sandboxed) launch spec for the server command,
// mirroring internal/artifacts.buildCommandSpec minus the output dir: the
// command runs in the checkout with the project's sandbox policy, cow mounts,
// and network access, and is told its port via HYDRA_PREVIEW_PORT.
func (in *instance) buildSpec(spec config.PreviewScript, childPort int) (*sandbox.Spec, bool, error) {
	home, _ := os.UserHomeDir()

	env := append([]string{}, os.Environ()...)
	if home != "" {
		env = append(env, "HOME="+home)
	}
	env = append(env,
		fmt.Sprintf("HYDRA_PREVIEW_PORT=%d", childPort),
		"HYDRA_PREVIEW_SOURCE="+in.runDir,
		"HYDRA_PREVIEW_REF="+in.version.SHA,
	)
	env = append(env, sandbox.MiseTrustEnv(in.root, in.runDir)...)

	command := spec.Script
	if spec.IsStrict() {
		command = sandbox.StrictScript(spec.Script)
	}
	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash, // a plain command, not an agent
		WorktreePath: in.runDir,             // always writable + chdir target
		Home:         home,
		Env:          env,
		Argv:         []string{"bash", "-c", command},
		NoSandbox:    spec.UnsafeHost,
	}

	var cowLayerDir string
	var egressSess *egress.Session
	hardMode := false
	if !spec.UnsafeHost {
		cfg, _ := config.Load(in.root)
		cfg.ApplySharedCaches(&opts, in.root, "", true)
		writable, readable, masked, cow, netPol, _ := cfg.ResolveSandboxOptions("")
		hardMode = netPol.Mode == sandbox.NetHard
		if gcd, err := git.GetCommonDir(in.root); err == nil {
			opts.GitCommonDir = gcd // ephemeral checkout git metadata lives here
		}
		opts.WritablePaths = writable
		opts.ReadablePaths = readable
		opts.MaskedPaths = sandbox.ResolveMaskedPaths(in.root, in.runDir, masked)
		// Per-spawn ephemeral cow layers over shared caches (see the artifacts
		// twin of this function for the full rationale).
		if len(cow) > 0 {
			cowBase := filepath.Join(previewDir(in.root), "cow")
			_ = os.MkdirAll(cowBase, 0o755)
			if base, err := os.MkdirTemp(cowBase, "run-"); err == nil {
				cowLayerDir = base
				opts.CowMounts = sandbox.ResolveCowMounts(in.root, in.runDir, home, base, cow, true)
			}
		}
		// Preview servers honor the project's network mode like agent heads do
		// (hard = pasta netns + nft + CONNECT proxy). Under hard mode the child's
		// port is forwarded INTO the netns (pasta -t) so the daemon's reverse
		// proxy and readiness prober can still reach 127.0.0.1:childPort from the
		// host. The session lives as long as the child (closed via launch.Cleanup,
		// which fires after cmd.Wait). Unknown hosts are silently denied.
		egressSess = egress.StartCommandEgress("preview:"+spec.Name, sandbox.AgentTypeBash, &netPol, childPort, nil)
		opts.Env = append(opts.Env, egressSess.Env...)
		opts.EgressWrap = egressSess.Wrap
		opts.Network = netPol
		opts.HardenGUI = true
		opts.Seccomp = true
	}

	// HYDRA_PREVIEW_ADDR is the host:port the server should bind, mode-aware:
	// under hard mode it must be 0.0.0.0 (pasta's inbound forward lands on the
	// netns's assigned address, not guest loopback), otherwise 127.0.0.1 keeps
	// the server off other interfaces. Server commands can pass it straight to
	// their listen flag instead of hardcoding a bind host.
	bindHost := "127.0.0.1"
	if hardMode {
		bindHost = "0.0.0.0"
	}
	opts.Env = append(opts.Env, "HYDRA_PREVIEW_ADDR="+net.JoinHostPort(bindHost, fmt.Sprintf("%d", childPort)))

	launch, err := sandbox.BuildSpec(opts)
	if err != nil {
		if cowLayerDir != "" {
			_ = os.RemoveAll(cowLayerDir)
		}
		egressSess.Close()
		return nil, false, errtrace.Wrap(err)
	}
	if cowLayerDir != "" || egressSess != nil {
		inner := launch.Cleanup
		launch.Cleanup = func() {
			if inner != nil {
				inner()
			}
			if cowLayerDir != "" {
				_ = os.RemoveAll(cowLayerDir)
			}
			egressSess.Close()
		}
	}
	return launch, hardMode, nil
}

// freePort asks the OS for an unused loopback TCP port. The listen/close/reuse
// race is accepted: the child binds it momentarily after.
func freePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port, nil
}

// exitMessage renders a process exit error compactly ("" for a clean exit).
func exitMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
