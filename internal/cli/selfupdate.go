package cli

import (
	"log"
	"net"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/selfupdate"
)

// newSelfUpdateManager builds the manager behind the UI's restart / update
// controls.
//
// SourceRoot is only set when the daemon's project root IS a Hydra checkout.
// Hydra manages other people's repositories as well as its own, and rebuilding
// the server from one of those would be nonsense - so a daemon booted anywhere
// else offers restart (re-exec what is already installed) but not update.
//
// Drain and KeepFiles are filled in later, by whichever of `hydra server` or
// `hydra __daemon` actually owns the listener and the runtime (see
// attachSelfUpdate).
func newSelfUpdateManager(projectRoot string) *selfupdate.Manager {
	exe, err := os.Executable()
	if err != nil {
		log.Printf("warn: cannot resolve our own executable, restart is disabled: %v", err)
		return &selfupdate.Manager{}
	}
	// Resolve symlinks so the swap renames the real file rather than replacing a
	// link to it. ~/.local/bin/hydra is a plain file today, but a
	// symlink-into-a-versioned-dir install is a normal enough shape to survive.
	if resolved, err := filepath.EvalSymlinks(exe); err == nil && resolved != "" {
		exe = resolved
	}

	m := &selfupdate.Manager{BinPath: exe}
	if selfupdate.IsHydraSource(projectRoot) {
		m.SourceRoot = projectRoot
	}
	return m
}

// attachSelfUpdate gives the manager the two things only the serving command
// knows: how to let go of everything that must not cross an exec, and which
// descriptors should cross it.
//
// The drain order matters and mirrors the normal shutdown path: stop the
// subprocesses we supervise, then the agent sessions, then close the database so
// SQLite's WAL is checkpointed rather than left for the next image to recover.
//
// Sessions are stopped explicitly rather than being left to die with the
// process. They would die anyway - the PTY masters are close-on-exec and bwrap
// carries --die-with-parent - but racing the exec makes the timing
// nondeterministic, and heads that resume from a clean stop resume better. See
// docs/deployment.md for the plan to carry the PTYs across instead.
func attachSelfUpdate(rt *daemonRuntime, ln net.Listener) {
	m := rt.server.SelfUpdate
	if m == nil {
		return
	}
	m.Drain = func() {
		rt.services.StopAll()
		rt.previews.StopAll()
		rt.reg.StopAll()
		if rt.store != nil {
			if err := rt.store.Close(); err != nil {
				log.Printf("warn: closing the database before restart: %v", err)
			}
		}
	}
	m.KeepFiles = func() ([]*os.File, []string, error) {
		if ln == nil {
			return nil, nil, nil
		}
		f, env, err := selfupdate.KeepListener(ln)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		return []*os.File{f}, env, nil
	}
}

// webListener returns the TCP listener for the web UI, preferring one handed
// over by the process we replaced. Inheriting it means the port is never
// unbound across a restart: connections that arrive mid-swap queue in the
// accept backlog instead of being refused.
func webListener(addr string) (net.Listener, error) {
	if ln := selfupdate.InheritedListener(); ln != nil {
		log.Printf("Server resuming on inherited socket %s", ln.Addr())
		return ln, nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, errtrace.Wrap(err) //nolint:wrapcheck // callers wrap with their own context
	}
	return ln, nil
}
