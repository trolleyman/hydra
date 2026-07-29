//go:build unix

package selfupdate

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"syscall"

	"braces.dev/errtrace"
	"golang.org/x/sys/unix"
)

const execSupported = true

// ListenerFDEnv names the environment variable carrying the inherited web
// listener's file descriptor number across a re-exec. Its presence is also the
// signal that this process IS a restart rather than a fresh start.
const ListenerFDEnv = "HYDRA_LISTENER_FD"

// KeepListener prepares a listening socket to survive an exec.
//
// Two things have to be true for a descriptor to cross exec(2): it must still be
// open (so we take a dup, leaving the original alone) and it must not be marked
// close-on-exec, which Go sets on everything it opens. Descriptor *numbers* are
// preserved by exec, so the new image is simply told which number to look at
// rather than the fd being shuffled to a fixed slot.
func KeepListener(ln net.Listener) (*os.File, []string, error) {
	fl, ok := ln.(interface{ File() (*os.File, error) })
	if !ok {
		return nil, nil, errtrace.Wrap(fmt.Errorf("listener of type %T cannot be duplicated", ln))
	}
	f, err := fl.File()
	if err != nil {
		return nil, nil, errtrace.Wrap(fmt.Errorf("duplicate listener: %w", err))
	}
	// Fd() also puts the descriptor back into blocking mode, which is what
	// net.FileListener expects to be handed on the other side.
	fd := int(f.Fd())
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil {
		_ = f.Close()
		return nil, nil, errtrace.Wrap(fmt.Errorf("clear close-on-exec: %w", err))
	}
	return f, []string{ListenerFDEnv + "=" + strconv.Itoa(fd)}, nil
}

// InheritedListener returns the listener handed over by the process we replaced,
// or nil if this is a fresh start. The environment entry is removed either way,
// so nothing we later spawn inherits a stale fd number.
func InheritedListener() net.Listener {
	value := os.Getenv(ListenerFDEnv)
	if value == "" {
		return nil
	}
	_ = os.Unsetenv(ListenerFDEnv)

	fd, err := strconv.Atoi(value)
	if err != nil || fd < 0 {
		return nil
	}
	f := os.NewFile(uintptr(fd), "hydra-web-listener")
	if f == nil {
		return nil
	}
	ln, err := net.FileListener(f)
	if err != nil {
		_ = f.Close()
		return nil
	}
	// net.FileListener dups again, so the descriptor we were handed is now
	// redundant. Leaving it open would leak one fd per restart.
	_ = f.Close()
	return ln
}

// execSelf replaces this process image with path, keeping it on the same PID.
//
// That last part is the point. Because the process never dies, a supervisor
// tracking MainPID (systemd's Type=simple) does not see a restart at all, so no
// restart policy, exit-code protocol or start rate limit is involved - and the
// identical code path works with no supervisor present. It is also what allows
// descriptors to be carried across, since there is no gap for the kernel to
// close them in.
//
// It does not return on success.
func execSelf(path string, keep []*os.File, extraEnv []string) error {
	if path == "" {
		return errtrace.Wrap(fmt.Errorf("no executable path to restart into"))
	}
	// argv[0] and the arguments are reused verbatim so the new image comes up in
	// exactly the mode this one was started in (`server`, `__daemon`, flags and
	// all).
	argv := append([]string(nil), os.Args...)
	env := append(os.Environ(), extraEnv...)

	err := syscall.Exec(path, argv, env)

	// Only reached on failure - but the keep-alive has to be after the call, not
	// deferred, so the runtime cannot decide these files are garbage and
	// finalise (closing) the very descriptors we prepared to hand over.
	for _, f := range keep {
		runtime.KeepAlive(f)
	}
	return errtrace.Wrap(fmt.Errorf("exec %s: %w", path, err))
}
