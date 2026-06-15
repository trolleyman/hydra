// Package daemon provides the hydrad control-plane: a per-project background
// process that owns agent PTY sessions and serves the existing HTTP API over a
// unix socket, plus the client and auto-start helpers the CLI uses to reach it.
package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
)

// runtimeDir returns a per-user directory for hydra runtime files (the control
// socket, lock, daemon log). It prefers XDG_RUNTIME_DIR, then TMPDIR, then /tmp.
func runtimeDir() string {
	if rt := os.Getenv("XDG_RUNTIME_DIR"); rt != "" {
		return filepath.Join(rt, "hydra")
	}
	base := os.TempDir()
	return filepath.Join(base, fmt.Sprintf("hydra-%d", os.Getuid()))
}

// ensureRuntimeDir creates the runtime dir with 0700 perms and returns it.
func ensureRuntimeDir() (string, error) {
	dir := runtimeDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create runtime dir: %w", err))
	}
	// Best-effort tighten perms in case it pre-existed with looser bits.
	_ = os.Chmod(dir, 0o700)
	return dir, nil
}

// projectKey returns a short stable hash of the (normalized) project root, used
// to name the socket/lock/log so each project gets its own daemon.
func projectKey(projectRoot string) string {
	sum := sha256.Sum256([]byte(projectRoot))
	return hex.EncodeToString(sum[:])[:16]
}

// SocketPath returns the unix socket path for the project's daemon.
func SocketPath(projectRoot string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, projectKey(projectRoot)+".sock"), nil
}

// lockPath returns the single-instance lock path for the project's daemon.
func lockPath(projectRoot string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, projectKey(projectRoot)+".lock"), nil
}

// logPath returns the daemon's log file path for the project.
func logPath(projectRoot string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, projectKey(projectRoot)+".log"), nil
}

// pidPath returns the file holding the running daemon's PID.
func pidPath(projectRoot string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, projectKey(projectRoot)+".pid"), nil
}

// infoPath returns the file holding the running daemon's binary stamp, used to
// detect when the on-disk hydra binary has been replaced (an upgrade).
func infoPath(projectRoot string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, projectKey(projectRoot)+".info"), nil
}
