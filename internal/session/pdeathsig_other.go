//go:build !linux

package session

import "os/exec"

// setPdeathsig is a no-op where the parent-death signal isn't available
// (darwin/bsd have no Pdeathsig field; windows has no SysProcAttr equivalent).
func setPdeathsig(cmd *exec.Cmd) {}
