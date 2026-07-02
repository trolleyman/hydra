//go:build !windows

package session

import (
	"os"
	"os/exec"

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

	if rows == 0 {
		rows = 24
	}
	if cols == 0 {
		cols = 80
	}
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
