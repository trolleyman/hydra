//go:build unix

package heads

import (
	"braces.dev/errtrace"
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// Give each composer command its own process group so Stop reaches pipelines
// and children waiting for input, even when bash has already exited.
func configureShellCommandCancellation(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return errtrace.Wrap(os.ErrProcessDone)
		}
		return errtrace.Wrap(err)
	}
}
