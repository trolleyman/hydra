//go:build unix

package preview

import (
	"os/exec"
	"syscall"
)

// configureProc puts the child in its own process group so we can signal the
// whole group (bash + build tools + the server it spawns), and disables the
// default CommandContext killer because stopChild handles group-wide
// SIGTERM/SIGKILL itself. Copied from internal/services (unexported there).
func configureProc(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error { return nil }
}

// terminateGroup sends SIGTERM to the process group led by pid. Best-effort.
func terminateGroup(pid int) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
}

// killGroup sends SIGKILL to the process group led by pid. Best-effort.
func killGroup(pid int) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}
