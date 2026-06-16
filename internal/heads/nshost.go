package heads

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/nshost"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// sharedNSEnabled reports whether the experimental shared-namespace host is on
// (env HYDRA_SHARED_NS=1). When set, a head's agent and its sandboxed bash
// terminals run as children of one supervisor inside a single bwrap, so they
// share that sandbox's writable copy-on-write overlay (see internal/nshost)
// instead of bash getting the COW sources read-only. Off by default.
func sharedNSEnabled() bool {
	switch os.Getenv("HYDRA_SHARED_NS") {
	case "1", "true", "yes":
		return true
	}
	return false
}

// nsHost is a running per-head supervisor: one bwrap whose pid-1 spawns PTY
// children sharing its namespace (and writable COW overlay).
type nsHost struct {
	id      string
	proc    *exec.Cmd
	client  *nshost.Client
	sockDir string
	cleanup func()
}

var nsHosts = struct {
	mu sync.Mutex
	m  map[string]*nsHost
}{m: map[string]*nsHost{}}

// namespaceHostFor returns the live supervisor for a head, if one exists.
func namespaceHostFor(id string) (*nsHost, bool) {
	nsHosts.mu.Lock()
	defer nsHosts.mu.Unlock()
	h, ok := nsHosts.m[id]
	return h, ok
}

// ensureNamespaceHost launches (once per head) the supervisor bwrap that owns
// the head's shared namespace and returns a client for spawning children in it.
// base is the sandbox the agent would otherwise run in; the supervisor reuses it
// verbatim (same binds, masks, network, writable COW) but runs __sandbox-init
// instead of the agent, and additionally exposes the control-socket dir writable
// so its listener is reachable from the daemon via the same bind-mounted path.
func ensureNamespaceHost(projectRoot, id string, base sandbox.Options) (*nsHost, error) {
	nsHosts.mu.Lock()
	defer nsHosts.mu.Unlock()
	if h, ok := nsHosts.m[id]; ok {
		return h, nil
	}

	sockDir := filepath.Join(paths.GetHydraDirFromProjectRoot(projectRoot), "ns", id)
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

	cmd := exec.Command(spec.Path, spec.Args[1:]...) //errtrace:skip
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.ExtraFiles = spec.ExtraFiles
	// The supervisor isn't PTY-attached; fold its logs into the daemon's.
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		spec.Cleanup()
		return nil, errtrace.Wrap(fmt.Errorf("start supervisor: %w", err))
	}

	if err := nshost.WaitForSocket(sockPath, 10*time.Second); err != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		spec.Cleanup()
		return nil, errtrace.Wrap(err)
	}

	h := &nsHost{id: id, proc: cmd, client: nshost.Dial(sockPath), sockDir: sockDir, cleanup: spec.Cleanup}
	nsHosts.m[id] = h
	log.Printf("heads: namespace host ready for %s (pid %d)", id, cmd.Process.Pid)
	return h, nil
}

// removeNamespaceHost tears down a head's supervisor and its socket dir.
// Best-effort; safe to call for heads that never had one.
func removeNamespaceHost(id string) {
	nsHosts.mu.Lock()
	h, ok := nsHosts.m[id]
	delete(nsHosts.m, id)
	nsHosts.mu.Unlock()
	if !ok {
		return
	}
	if h.proc != nil && h.proc.Process != nil {
		_ = h.proc.Process.Kill()
		_, _ = h.proc.Process.Wait()
	}
	if h.cleanup != nil {
		h.cleanup()
	}
	_ = os.RemoveAll(h.sockDir)
}

// startAgentSession starts the agent either in its own sandbox (default) or, when
// the shared-namespace flag is on, as a child of the head's supervisor so it
// shares the writable COW overlay with bash terminals. sb carries the agent's
// argv, env and (for the namespace path) the pre-spawn script to wrap around it.
func startAgentSession(reg *session.Registry, projectRoot, id string, agentType sandbox.AgentType, worktree string, rows, cols uint16, sb sandbox.Options) (*session.Session, error) {
	if !sharedNSEnabled() {
		return reg.Start(session.StartOptions{ID: id, Rows: rows, Cols: cols, Sandbox: sb})
	}

	host, err := ensureNamespaceHost(projectRoot, id, sb)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	argv := sandbox.WrapPreSpawn(sb.PreSpawnScript, sb.Argv)
	sp, err := host.client.Spawn(nshost.SpawnRequest{Argv: argv, Env: sb.Env, Cwd: worktree, Rows: rows, Cols: cols})
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("spawn agent in namespace host: %w", err))
	}
	return reg.StartWithProc(id, agentType, worktree, rows, cols, false, sp)
}
