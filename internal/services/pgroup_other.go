//go:build !unix

package services

import "os/exec"

// On non-unix platforms (Windows is stubbed in this codebase) there is no
// process-group signalling; these are best-effort no-ops. configureProc leaves
// the default CommandContext killer in place so ctx cancel still terminates the
// leader process.

func configureProc(cmd *exec.Cmd) {}

func terminateGroup(pid int) {}

func killGroup(pid int) {}
