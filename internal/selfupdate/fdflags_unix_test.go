//go:build unix

package selfupdate

import (
	"testing"

	"golang.org/x/sys/unix"
)

// closeOnExec reports whether fd would be closed by an exec. Clearing that flag
// is what lets the web listener cross a restart (see KeepListener), so the test
// that asserts it needs a way to read it back.
func closeOnExec(t *testing.T, fd int) bool {
	t.Helper()
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		t.Fatalf("F_GETFD on fd %d: %v", fd, err)
	}
	return flags&unix.FD_CLOEXEC != 0
}
