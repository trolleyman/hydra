//go:build !linux

package heads

import "os/exec"

// setSupervisorPdeathsig is a no-op where the parent-death signal isn't available
// (darwin/bsd have no Pdeathsig field). The systemd-scope wrapping is Linux-only
// too, so nothing is interposed between the daemon and bwrap on these platforms.
func setSupervisorPdeathsig(cmd *exec.Cmd) {}
