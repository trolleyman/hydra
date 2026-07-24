//go:build linux

package heads

import (
	"os/exec"
	"syscall"
)

// setSupervisorPdeathsig asks the kernel to SIGKILL the supervisor process when
// the daemon (its parent) dies. Linux-only: Pdeathsig is not a field of
// syscall.SysProcAttr on darwin/bsd. Mirrors session.setPdeathsig - when the
// supervisor is wrapped in a systemd scope, systemd-run becomes the outermost
// process and this ties it (and, via bwrap's --die-with-parent, the whole head)
// to the daemon's lifetime, preserving the instant kill-on-daemon-death that the
// unscoped supervisor gets for free from bwrap being a direct child.
func setSupervisorPdeathsig(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
