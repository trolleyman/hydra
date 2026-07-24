//go:build !unix

package session

import "syscall"

// signalGroup is a no-op on platforms without process groups / syscall.Kill.
func signalGroup(pid int, sig syscall.Signal) {}
