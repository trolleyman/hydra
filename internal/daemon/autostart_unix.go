//go:build !windows

package daemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"braces.dev/errtrace"
)

// EnsureRunning starts the project's daemon if it is not already answering its
// socket. It serializes concurrent callers with a file lock and waits for the
// new daemon to become ready.
func EnsureRunning(ctx context.Context, projectRoot string) error {
	sock, err := SocketPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	lock, err := lockPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	lf, err := os.OpenFile(lock, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("open daemon lock: %w", err))
	}
	defer lf.Close()
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX); err != nil {
		return errtrace.Wrap(fmt.Errorf("acquire daemon lock: %w", err))
	}
	defer syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)

	// Another process may have started the daemon while we waited for the lock.
	c := &Client{sock: sock, http: unixHTTPClient(sock)}
	if c.ping(ctx) {
		return nil
	}

	// A stale socket file blocks bind(); the daemon removes it, but clean up
	// here too in case the previous daemon died uncleanly.
	if _, statErr := os.Stat(sock); statErr == nil {
		_ = os.Remove(sock)
	}

	exe, err := os.Executable()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("resolve hydra executable: %w", err))
	}

	logFile, err := daemonLogFile(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "__daemon", "--project", projectRoot)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return errtrace.Wrap(fmt.Errorf("start daemon: %w", err))
	}
	// Detach: we don't wait on the daemon, but reap nothing (Setsid + no Wait
	// leaves it owned by init once we exit).
	_ = cmd.Process.Release()

	// Wait for readiness.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if c.ping(ctx) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errtrace.Errorf("daemon did not become ready; see %s", logFilePathOrUnknown(projectRoot))
}

func daemonLogFile(projectRoot string) (*os.File, error) {
	p, err := logPath(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("open daemon log: %w", err))
	}
	return f, nil
}

func logFilePathOrUnknown(projectRoot string) string {
	if p, err := logPath(projectRoot); err == nil {
		return p
	}
	return "the daemon log"
}
