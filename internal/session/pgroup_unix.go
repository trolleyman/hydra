//go:build unix

package session

import "syscall"

// signalGroup sends sig to the entire process group led by pid. Sessions are
// started as session/group leaders (creack/pty sets Setsid), so pid == pgid and
// -pid targets every process in the group, not just the leader. This catches any
// strays that would otherwise be missed by signalling the leader alone. If pid is
// not actually a group leader the kernel returns ESRCH and nothing happens, so
// it is safe to call for arbitrary PTY-backed processes. Best-effort.
func signalGroup(pid int, sig syscall.Signal) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, sig)
}
