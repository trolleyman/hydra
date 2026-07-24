//go:build !windows

package session

import (
	"os"
	"os/exec"
	"runtime"

	"braces.dev/errtrace"
	"github.com/creack/pty"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// ptyProcess is a child process attached to a pseudo-terminal master.
type ptyProcess struct {
	master *os.File
	cmd    *exec.Cmd
}

// startProcess launches spec under a new PTY of the given initial size.
func startProcess(spec *sandbox.Spec, rows, cols uint16) (*ptyProcess, error) {
	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.ExtraFiles = spec.ExtraFiles

	// Tie the sandbox to the daemon's lifetime (Linux only; Pdeathsig is not a
	// darwin/bsd SysProcAttr field). If the daemon dies for any reason the
	// graceful drain can't handle - a crash, an outright SIGKILL, a botched
	// auto-upgrade - the kernel SIGKILLs the outermost sandbox process (pasta in
	// hard-egress mode, otherwise bwrap). bwrap's own --die-with-parent then
	// cascades the kill down through the unshared PID namespace, so the agent
	// (and anything it spawned, e.g. a headless Chrome) dies too instead of being
	// reparented to systemd and left running. creack/pty preserves this
	// SysProcAttr and layers Setsid+Setctty on top.
	setPdeathsig(cmd)

	if rows == 0 {
		rows = 24
	}
	if cols == 0 {
		cols = 80
	}

	// Pdeathsig is delivered when the OS thread that forked the child exits, not
	// only when the whole daemon does - and the Go runtime can retire idle
	// threads. Lock this goroutine to its thread across the fork so the runtime
	// keeps that thread alive afterwards and the signal can't fire early (which
	// would kill a live agent). Best-effort; a cgroup scope is the definitive
	// guarantee (see internal/sandbox scope handling).
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &ptyProcess{master: master, cmd: cmd}, nil
}

func (p *ptyProcess) Read(b []byte) (int, error)  { return p.master.Read(b) }  //errtrace:skip
func (p *ptyProcess) Write(b []byte) (int, error) { return p.master.Write(b) } //errtrace:skip
func (p *ptyProcess) Close() error                { return p.master.Close() }  //errtrace:skip

func (p *ptyProcess) Resize(rows, cols uint16) error {
	return errtrace.Wrap(pty.Setsize(p.master, &pty.Winsize{Rows: rows, Cols: cols}))
}

func (p *ptyProcess) Wait() error {
	return errtrace.Wrap(p.cmd.Wait())
}

func (p *ptyProcess) Pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

// Signal sends sig to the process.
func (p *ptyProcess) Signal(sig os.Signal) error {
	if p.cmd.Process == nil {
		return nil
	}
	return errtrace.Wrap(p.cmd.Process.Signal(sig))
}
