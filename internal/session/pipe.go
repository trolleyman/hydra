package session

import (
	"io"
	"os"
	"os/exec"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/scope"
)

// pipeProcess is a child process with protocol-safe stdin/stdout pipes. Stderr
// remains diagnostic output and must never be folded into a structured stream.
type pipeProcess struct {
	stdin  io.WriteCloser
	stdout io.ReadCloser
	cmd    *exec.Cmd
}

func startPipeProcess(spec *sandbox.Spec) (*pipeProcess, error) {
	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.ExtraFiles = spec.ExtraFiles
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, errtrace.Wrap(err)
	}
	if err := scope.Start(cmd); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, errtrace.Wrap(err)
	}
	return &pipeProcess{stdin: stdin, stdout: stdout, cmd: cmd}, nil
}

func (p *pipeProcess) Read(b []byte) (int, error)  { return p.stdout.Read(b) } //errtrace:skip
func (p *pipeProcess) Write(b []byte) (int, error) { return p.stdin.Write(b) } //errtrace:skip
func (p *pipeProcess) Resize(uint16, uint16) error { return nil }
func (p *pipeProcess) Wait() error                 { return errtrace.Wrap(p.cmd.Wait()) }

func (p *pipeProcess) Close() error {
	stdinErr := p.stdin.Close()
	stdoutErr := p.stdout.Close()
	if stdinErr != nil {
		return errtrace.Wrap(stdinErr)
	}
	return errtrace.Wrap(stdoutErr)
}

func (p *pipeProcess) Pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *pipeProcess) Signal(sig os.Signal) error {
	if p.cmd.Process == nil {
		return nil
	}
	return errtrace.Wrap(p.cmd.Process.Signal(sig))
}
