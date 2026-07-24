//go:build linux

package session

import (
	"os/exec"
	"syscall"
)

// setPdeathsig asks the kernel to SIGKILL the child when the daemon (its parent)
// dies. Linux-only: Pdeathsig is not a field of syscall.SysProcAttr on darwin/bsd.
func setPdeathsig(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
