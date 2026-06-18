//go:build unix

package services

import (
	"os/exec"
	"syscall"
)

// configureProc puts the child in its own process group so we can signal the
// whole group (the command plus any children it spawns, e.g. emulators), and
// disables the default CommandContext killer because supervise() handles
// group-wide SIGTERM/SIGKILL on ctx cancel itself.
func configureProc(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error { return nil }
}

// terminateGroup sends SIGTERM to the process group led by pid (negative pid =
// the whole group). Best-effort.
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
