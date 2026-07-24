package heads

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/nshost"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// nsHost is a running per-head supervisor: one bwrap (pid 1 of which is bwrap's
// own reaper; our supervisor runs as its child) that spawns PTY children sharing
// its namespace and writable COW overlay.
type nsHost struct {
	id      string
	proc    *exec.Cmd
	client  *nshost.Client
	sockDir string
	// scopeUnit is the transient systemd scope wrapping the supervisor (and thus
	// the whole head's process subtree), or "" when scopes are unavailable. Stopped
	// on teardown so the cgroup is reaped as a unit.
	scopeUnit string
	cleanup   func()
	// done is closed once the supervisor has exited and its resources are
	// reclaimed (by the watcher). removeNamespaceHost blocks on it for a
	// synchronous teardown.
	done chan struct{}
}

// nsHostEntry is the registry slot for a head's supervisor. ready is closed once
// host/err are populated, so concurrent callers for the same head wait for the
// single in-flight launch instead of double-launching - and the global lock is
// only ever held briefly (never across the launch + socket wait).
type nsHostEntry struct {
	ready chan struct{}
	host  *nsHost
	err   error
}

var nsHosts = struct {
	mu sync.Mutex
	m  map[string]*nsHostEntry
}{m: map[string]*nsHostEntry{}}

// namespaceHostFor returns the live supervisor for a head, if one exists and its
// launch succeeded.
func namespaceHostFor(id string) (*nsHost, bool) {
	nsHosts.mu.Lock()
	e, ok := nsHosts.m[id]
	nsHosts.mu.Unlock()
	if !ok {
		return nil, false
	}
	<-e.ready
	return e.host, e.host != nil
}

// ensureNamespaceHost launches (once per head) the supervisor bwrap that owns the
// head's shared namespace and returns a client for spawning children in it. The
// global lock is held only to claim the registry slot; the slow launch runs
// without it, and concurrent callers for the same head block on the slot's ready
// channel rather than relaunching.
func ensureNamespaceHost(projectRoot, id string, base sandbox.Options) (*nsHost, error) {
	nsHosts.mu.Lock()
	if e, ok := nsHosts.m[id]; ok {
		nsHosts.mu.Unlock()
		<-e.ready
		return e.host, errtrace.Wrap(e.err)
	}
	e := &nsHostEntry{ready: make(chan struct{})}
	nsHosts.m[id] = e
	nsHosts.mu.Unlock()

	host, err := launchNamespaceHost(projectRoot, id, base)
	e.host, e.err = host, err
	if err == nil {
		// Watch the supervisor: if it exits (crash or explicit kill), evict the slot
		// and reclaim resources, so a later attach/resume re-creates a fresh host.
		// Started before ready is closed so a concurrent removeNamespaceHost always
		// has a watcher to close done.
		go watchNamespaceHost(id, host, e)
	}
	close(e.ready)

	if err != nil {
		// Drop the failed slot so a later spawn can retry.
		nsHosts.mu.Lock()
		if nsHosts.m[id] == e {
			delete(nsHosts.m, id)
		}
		nsHosts.mu.Unlock()
		return nil, errtrace.Wrap(err)
	}
	return host, nil
}

// launchNamespaceHost does the actual (slow) work of starting a supervisor bwrap:
// it reuses base verbatim (same binds, masks, network, writable COW) but runs
// __sandbox-init instead of the agent, and additionally exposes the control-socket
// dir writable so its listener is reachable from the daemon via the same
// bind-mounted path.
func launchNamespaceHost(projectRoot, id string, base sandbox.Options) (*nsHost, error) {
	sockDir := paths.GetNamespaceSocketDirFromProjectRoot(projectRoot, id)
	if err := os.MkdirAll(sockDir, 0o700); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create ns socket dir: %w", err))
	}
	sockPath := filepath.Join(sockDir, "control.sock")
	_ = os.Remove(sockPath)

	hostOpts := base
	hostOpts.Argv = []string{SandboxHydraBinPath, "__sandbox-init", "--socket", sockPath}
	hostOpts.PreSpawnScript = "" // the supervisor itself runs no pre-spawn hook
	hostOpts.WritablePaths = append(append([]string(nil), base.WritablePaths...), sockDir)

	spec, err := sandbox.BuildSpec(hostOpts)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("build supervisor sandbox: %w", err))
	}

	// Wrap the supervisor in a transient systemd user scope so the whole head -
	// the agent plus every sibling bash shell that shares this one bwrap - lives
	// in a single per-head cgroup carrying the project's resolved resource limits,
	// reapable as a unit and unable to outlive the daemon by reparenting to
	// systemd. Best-effort: a no-op (scoped=false) where scopes are unavailable,
	// leaving the supervisor a direct child of the daemon as before. config.Load is
	// cached, so the re-read is cheap.
	scopeUnit := sandbox.ScopeUnit("", id)
	limitsCfg, _ := config.Load(projectRoot)
	scoped := sandbox.WrapScope(scopeUnit, spec, limitsCfg.ResolveResourceLimits())

	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.ExtraFiles = spec.ExtraFiles
	// The supervisor isn't PTY-attached; fold its logs into the daemon's, while
	// also keeping the tail so a startup failure (e.g. a bad bwrap mount) can be
	// folded into the error below instead of vanishing into "socket never appeared".
	var errTail capWriter
	cmd.Stdout = os.Stderr
	cmd.Stderr = io.MultiWriter(os.Stderr, &errTail)
	// Tie the outermost process to the daemon's lifetime so an ungraceful daemon
	// death (crash, SIGKILL, botched auto-upgrade) SIGKILLs it and bwrap's
	// --die-with-parent cascades the kill through the head's PID namespace - the
	// agent and anything it spawned die immediately instead of orphaning to
	// systemd (the ~load-106 incident that motivated scoping). When unscoped bwrap
	// is that direct child; when scoped systemd-run is, so it needs the signal to
	// pass the kill down. The scope + boot-time sweep are only the backstop. Lock
	// the OS thread across the fork so the Go runtime can't retire the forking
	// thread and fire Pdeathsig early (see session.startProcess).
	setSupervisorPdeathsig(cmd)
	runtime.LockOSThread()
	startErr := cmd.Start()
	runtime.UnlockOSThread()
	if startErr != nil {
		if scoped {
			sandbox.StopScope(scopeUnit)
		}
		spec.Cleanup()
		return nil, errtrace.Wrap(fmt.Errorf("start supervisor: %w", startErr))
	}

	if err := nshost.WaitForSocket(sockPath, 10*time.Second); err != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		if scoped {
			sandbox.StopScope(scopeUnit) // reap the cgroup; killing systemd-run alone may not
		}
		spec.Cleanup()
		if tail := strings.TrimSpace(errTail.String()); tail != "" {
			return nil, errtrace.Wrap(fmt.Errorf("%w; supervisor output: %s", err, tail))
		}
		return nil, errtrace.Wrap(err)
	}

	unit := ""
	if scoped {
		unit = scopeUnit
	}
	log.Printf("heads: namespace host ready for %s (pid %d)", id, cmd.Process.Pid)
	return &nsHost{id: id, proc: cmd, client: nshost.Dial(sockPath), sockDir: sockDir, scopeUnit: unit, cleanup: spec.Cleanup, done: make(chan struct{})}, nil
}

// watchNamespaceHost is the sole waiter on the supervisor process. It blocks until
// the supervisor exits - whether on its own (crash) or because removeNamespaceHost
// killed it - then evicts the registry slot, runs the spec cleanup, removes the
// socket dir, and signals done.
func watchNamespaceHost(id string, h *nsHost, e *nsHostEntry) {
	_ = h.proc.Wait()
	nsHosts.mu.Lock()
	if nsHosts.m[id] == e {
		delete(nsHosts.m, id)
	}
	nsHosts.mu.Unlock()
	// The netns (and its baked-in nft egress-port rule) is gone with the supervisor,
	// so drop the remembered egress port: a later relaunch must allocate a fresh one
	// and bake it into the fresh supervisor, not try to reclaim the dead port.
	forgetEgressPort(id)
	// Reap the head's transient scope now that the supervisor has exited: this
	// clears the (now-empty) unit and SIGKILLs any stray process still in its
	// cgroup, so nothing lingers even if the --die-with-parent cascade missed one.
	// Best-effort and a no-op for an unscoped supervisor (scopeUnit == "").
	sandbox.StopScope(h.scopeUnit)
	if h.cleanup != nil {
		h.cleanup()
	}
	_ = os.RemoveAll(h.sockDir)
	close(h.done)
}

// removeNamespaceHost tears down a head's supervisor synchronously: it signals the
// process and waits for the watcher to reclaim everything. Best-effort; safe to
// call for heads that never had one.
func removeNamespaceHost(id string) {
	// Covers the aborted-spawn path where the supervisor launch failed (no watcher
	// ever runs to clear it) as well as a supervisor that never started; the normal
	// teardown below also clears it via watchNamespaceHost. Idempotent.
	forgetEgressPort(id)
	nsHosts.mu.Lock()
	e, ok := nsHosts.m[id]
	nsHosts.mu.Unlock()
	if !ok {
		return
	}
	<-e.ready
	h := e.host
	if h == nil {
		return // launch failed; the slot was already dropped by ensureNamespaceHost
	}
	if h.proc != nil && h.proc.Process != nil {
		_ = h.proc.Process.Kill()
	}
	<-h.done // watcher evicts the slot and reclaims resources
}

// startAgentSession starts the agent as a child of the head's supervisor (the
// "namespace host") so it shares one bwrap - and one writable copy-on-write
// overlay - with the head's sandboxed bash terminals. sb carries the agent's
// argv, env and the pre-spawn script.
func startAgentSession(reg *session.Registry, projectRoot, id string, agentType sandbox.AgentType, worktree string, rows, cols uint16, sb sandbox.Options) (*session.Session, error) {
	host, err := ensureNamespaceHost(projectRoot, id, sb)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	// Wrap the pre-spawn script around the agent's argv so it runs inside the
	// supervisor's bwrap (the same one the agent and bash terminals share), exactly
	// as withPreSpawn does for a standalone sandbox - its writes land in the shared
	// COW overlay and are visible to every sibling terminal.
	// Persist the resolved $HYDRA_ENV to the per-head /tmp so the daemon can read
	// it back and inject the same vars into this head's sibling sandboxed shells
	// (StartShellSession), which do not re-run the script.
	argv := sandbox.WrapPreSpawn(sb.PreSpawnScript, sandbox.SandboxPreSpawnEnvFile(sb.TmpDir), sb.Argv)
	sp, err := host.client.Spawn(nshost.SpawnRequest{Argv: argv, Env: sb.Env, Cwd: worktree, Rows: rows, Cols: cols, Pipes: sb.StdioPipes})
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("spawn agent in namespace host: %w", err))
	}
	kind := session.KindTerminal
	if sb.StdioPipes {
		kind = session.KindChat
	}
	return errtrace.Wrap2(reg.StartWithProc(id, agentType, worktree, rows, cols, false, kind, sp))
}

// runPreExitInNamespace runs a pre_exit_script as a child of the head's live
// supervisor, so it executes in the same bwrap (and writable COW overlay) as the
// agent did. It returns the hook's combined PTY output. The child is PTY-attached
// like every namespace-host process; output is read until the child exits (EOF on
// the master) or ctx fires, whichever comes first.
func runPreExitInNamespace(ctx context.Context, host *nsHost, worktree string, env []string, script string) ([]byte, error) {
	sp, err := host.client.Spawn(nshost.SpawnRequest{
		Argv: []string{"/bin/bash", "-c", sandbox.StrictScript(script)},
		Env:  env,
		Cwd:  worktree,
		Rows: 24, Cols: 80,
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	resCh := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(sp)
		resCh <- data
	}()

	select {
	case out := <-resCh:
		_ = sp.Close()
		return out, nil
	case <-ctx.Done():
		// The master fd (received over the socket) is blocking, so closing it does
		// not interrupt a blocked read; actively kill the child via the supervisor
		// so it exits, the master EOFs, and the reader returns.
		_ = sp.Signal(syscall.SIGKILL)
		out := <-resCh
		_ = sp.Close()
		return out, errtrace.Wrap(fmt.Errorf("pre_exit_script timed out after %s", preExitTimeout))
	}
}

// capWriter is an io.Writer that retains only the last capWriterMax bytes written
// to it - a tiny ring used to keep the supervisor's final stderr lines so a
// launch failure can fold them into its error without buffering unbounded output.
type capWriter struct {
	mu  sync.Mutex
	buf []byte
}

const capWriterMax = 4096

func (w *capWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	if len(w.buf) > capWriterMax {
		w.buf = w.buf[len(w.buf)-capWriterMax:]
	}
	return len(p), nil
}

func (w *capWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.buf)
}
