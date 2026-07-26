//go:build !linux

package scope

import "os/exec"

// setPdeathsig is a no-op where the parent-death signal isn't available
// (darwin/bsd have no Pdeathsig field). The systemd-scope wrapping is Linux-only
// anyway, so on those platforms there is no scope lifetime to tie a command to.
func setPdeathsig(cmd *exec.Cmd) {}
