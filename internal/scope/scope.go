// Package scope is the single seam where a workload runner (artifact generator,
// preview server, long-running service, test runner, agent head supervisor)
// launches a sandboxed command tied to the daemon: it wraps the launch spec in a
// transient systemd scope carrying the project's configured cgroup resource
// limits, and starts it with a parent-death signal so the whole subtree dies with
// the daemon instead of orphaning. Centralising it keeps that policy in one place
// instead of copy-pasted at every runner.
package scope

import (
	"context"
	"os/exec"
	"runtime"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// Apply rewrites spec to run under a transient systemd scope named unit, applying
// projectRoot's configured resource limits (CPU/IO weight plus any hard caps).
// It is best-effort: a no-op where systemd scopes are unavailable, and it never
// fails a spawn (a config load error falls back to the default limits). The
// caller owns the unit name and must sandbox.StopScope(unit) on teardown to reap
// the cgroup. Returns whether the scope actually took effect (false where scopes
// are unavailable), which a caller can use to skip a StopScope it would otherwise
// run on an error path; runners that always defer StopScope can ignore it.
func Apply(projectRoot, unit string, spec *sandbox.Spec) bool {
	limits, _ := config.Load(projectRoot)
	return sandbox.WrapScope(unit, spec, limits.ResolveResourceLimits(projectRoot))
}

// Command builds the exec.Cmd for a launch spec - the Path/Args/Dir/Env/ExtraFiles
// wiring every runner repeats. The caller still wires stdout/stderr (each does it
// differently) plus any process-group setup (configureProc), then hands the cmd
// to Start.
func Command(ctx context.Context, spec *sandbox.Spec) *exec.Cmd {
	cmd := exec.CommandContext(ctx, spec.Path, spec.Args[1:]...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.ExtraFiles = spec.ExtraFiles
	return cmd
}

// StartFunc launches cmd tied to the daemon's lifetime, running the supplied
// start to do the actual fork (cmd.Start for a plain child, pty.StartWithSize for
// a PTY session). It sets the parent-death signal so the kernel SIGKILLs cmd when
// the daemon (its parent) dies; combined with the scope's systemd-run and bwrap's
// --die-with-parent, that brings the whole sandbox subtree down immediately on an
// ungraceful daemon death (crash, SIGKILL, botched auto-upgrade) instead of
// orphaning it to systemd until the next boot-time sweep. It pins the OS thread
// across the fork so the Go runtime can't retire the forking thread and fire the
// parent-death signal early. The parent-death signal is Linux-only (a no-op
// elsewhere); the OS-thread pin is cheap and harmless everywhere.
func StartFunc(cmd *exec.Cmd, start func() error) error {
	setPdeathsig(cmd)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	return errtrace.Wrap(start())
}

// Start is StartFunc for the common case of a plain cmd.Start.
func Start(cmd *exec.Cmd) error {
	return errtrace.Wrap(StartFunc(cmd, cmd.Start))
}
