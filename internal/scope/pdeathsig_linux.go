//go:build linux

package scope

import (
	"os/exec"
	"syscall"
)

// setPdeathsig asks the kernel to SIGKILL cmd when its parent (the daemon) dies.
// Linux-only: Pdeathsig is not a field of syscall.SysProcAttr on darwin/bsd. It
// is additive - it augments any SysProcAttr a caller already set (e.g. Setpgid
// from configureProc) rather than replacing it.
func setPdeathsig(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
