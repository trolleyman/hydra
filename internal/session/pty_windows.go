//go:build windows

package session

import (
	"errors"
	"os"

	"github.com/trolleyman/hydra/internal/sandbox"
)

// ptyProcess is a placeholder on Windows; ConPTY support lands with the Windows
// sandbox backend.
type ptyProcess struct{}

func startProcess(spec *sandbox.Spec, rows, cols uint16) (*ptyProcess, error) {
	return nil, errors.New("hydra: PTY sessions are not yet supported on Windows")
}

func (p *ptyProcess) Read(b []byte) (int, error)     { return 0, errors.New("unsupported") }
func (p *ptyProcess) Write(b []byte) (int, error)    { return 0, errors.New("unsupported") }
func (p *ptyProcess) Close() error                   { return nil }
func (p *ptyProcess) Resize(rows, cols uint16) error { return nil }
func (p *ptyProcess) Wait() error                    { return nil }
func (p *ptyProcess) Pid() int                       { return 0 }
func (p *ptyProcess) Signal(sig os.Signal) error     { return nil }
