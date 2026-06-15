package daemon

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"braces.dev/errtrace"
)

// binaryStamp returns a fingerprint of the current hydra executable (modtime +
// size). When the on-disk binary is rebuilt/replaced, this changes, which the
// CLI uses to decide the running daemon is stale and should be restarted.
func binaryStamp() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	info, err := os.Stat(exe)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return fmt.Sprintf("%d-%d", info.ModTime().UnixNano(), info.Size()), nil
}

// writeDaemonFiles records the daemon's PID and binary stamp. Called at startup.
func WriteDaemonFiles(projectRoot string) error {
	pp, err := pidPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.WriteFile(pp, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return errtrace.Wrap(err)
	}
	stamp, err := binaryStamp()
	if err != nil {
		return errtrace.Wrap(err)
	}
	ip, err := infoPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(ip, []byte(stamp), 0o600))
}

// removeDaemonFiles cleans up the PID/info files at shutdown.
func RemoveDaemonFiles(projectRoot string) {
	if pp, err := pidPath(projectRoot); err == nil {
		_ = os.Remove(pp)
	}
	if ip, err := infoPath(projectRoot); err == nil {
		_ = os.Remove(ip)
	}
}

// isStale reports whether the running daemon was started from a now-replaced
// binary (i.e. the user rebuilt hydra). Best-effort: returns false on any error.
func isStale(projectRoot string) bool {
	ip, err := infoPath(projectRoot)
	if err != nil {
		return false
	}
	recorded, err := os.ReadFile(ip)
	if err != nil {
		return false
	}
	current, err := binaryStamp()
	if err != nil {
		return false
	}
	return string(recorded) != current
}

// StopDaemon stops the project's running daemon (if any) and waits for its
// socket to stop answering. It only signals a daemon that is actually answering
// its socket, so a stale PID file can't cause an unrelated (pid-reused) process
// to be signalled; stale runtime files are simply cleaned up. Running heads are
// resumed when a new server boots.
func StopDaemon(ctx context.Context, projectRoot string) error {
	sock, err := SocketPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	c := &Client{sock: sock, http: unixHTTPClient(sock)}
	if !c.ping(ctx) {
		// Nothing live is answering; just clear stale files so a fresh bind works.
		RemoveDaemonFiles(projectRoot)
		_ = os.Remove(sock)
		return nil
	}

	pp, err := pidPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if data, err := os.ReadFile(pp); err == nil {
		if pid, err := strconv.Atoi(string(data)); err == nil && pid > 0 {
			// Belt-and-suspenders: only signal a PID we can confirm is a hydra
			// daemon. The socket ping above already implies a live daemon, but a
			// stale pidfile plus PID reuse could otherwise point us at an
			// unrelated process — we must never SIGTERM something we don't own.
			if pidIsHydraDaemon(pid) {
				if proc, err := os.FindProcess(pid); err == nil {
					_ = proc.Signal(syscall.SIGTERM)
				}
			}
		}
	}

	// Wait for the old daemon's socket to stop answering.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !c.ping(ctx) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errtrace.Errorf("existing daemon did not stop")
}

// pidIsHydraDaemon reports whether pid looks like a hydra daemon, used as a
// guard before signalling so a stale pidfile (after PID reuse) can never make us
// TERM an unrelated process. It inspects /proc/<pid>/cmdline for the hidden
// `__daemon` subcommand. On platforms without /proc (or if the cmdline can't be
// read) it returns true so behaviour is unchanged — the socket-ping guard in
// StopDaemon already establishes that a live hydra daemon is answering.
func pidIsHydraDaemon(pid int) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return true // can't introspect (non-Linux, races); rely on the ping guard
	}
	return slices.Contains(strings.Split(string(data), "\x00"), "__daemon")
}
