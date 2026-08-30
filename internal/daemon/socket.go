// Package daemon provides the hydrad control-plane: a per-project background
// process that owns agent PTY sessions and serves the existing HTTP API over a
// unix socket, plus the client and auto-start helpers the CLI uses to reach it.
package daemon

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/statepath"
)

// runtimeDir returns a per-user directory for hydra runtime files (the control
// socket, lock, daemon log). It prefers XDG_RUNTIME_DIR, then TMPDIR, then /tmp.
func runtimeDir() string {
	if rt := os.Getenv("XDG_RUNTIME_DIR"); rt != "" {
		return namespacedRuntimeDir(filepath.Join(rt, "hydra"))
	}
	base := os.TempDir()
	return namespacedRuntimeDir(filepath.Join(base, fmt.Sprintf("hydra-%d", os.Getuid())))
}

// namespacedRuntimeDir gives an explicit development state root its own complete
// daemon control plane. Hashing the resolved state path keeps it opaque and
// prevents path separators or traversal from escaping the runtime directory.
func namespacedRuntimeDir(base string) string {
	namespace := statepath.RuntimeIsolationKey()
	if namespace == "" {
		return base
	}
	sum := sha256.Sum256([]byte(namespace))
	return filepath.Join(base, fmt.Sprintf("instance-%x", sum[:8]))
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

// NamespaceHostSocketDir creates a short, random directory for one head's
// namespace-supervisor socket. The capability-like random key avoids encoding
// project or head identity in runtime filenames. A directory is used because
// Linux sandboxes bind only this one socket location into the head.
func NamespaceHostSocketDir(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	key := make([]byte, 12)
	if _, err := rand.Read(key); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("generate namespace-host socket key: %w", err))
	}
	sockDir := filepath.Join(dir, "head-control", hex.EncodeToString(key))
	const socketName = "control.sock"
	const portableUnixSocketPathMax = 103
	if len(filepath.Join(sockDir, socketName)) > portableUnixSocketPathMax {
		// XDG_RUNTIME_DIR is normally the short /run/user/<uid>, but callers may
		// override it with an arbitrarily long path. Keep a bounded last resort
		// rather than allowing bind(2) to fail with an opaque EINVAL.
		base := filepath.Join("/tmp", fmt.Sprintf("hydra-%d", os.Getuid()))
		dir = namespacedRuntimeDir(base)
		sockDir = filepath.Join(dir, "head-control", hex.EncodeToString(key))
	}
	if err := os.MkdirAll(sockDir, 0o700); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create namespace-host runtime dir: %w", err))
	}
	_ = os.Chmod(sockDir, 0o700)
	return sockDir, nil
}

// SocketPath returns the user-global daemon socket. projectRoot is retained in
// the signature for callers compiled against the former per-project contract.
func SocketPath(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, "daemon.sock"), nil
}

// lockPath returns the single-instance lock path for the user-global daemon.
func lockPath(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, "daemon.lock"), nil
}

// logPath returns the daemon's log file path for the project.
func logPath(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, "daemon.log"), nil
}

// pidPath returns the file holding the running daemon's PID.
func pidPath(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, "daemon.pid"), nil
}

// infoPath returns the file holding the running daemon's binary stamp, used to
// detect when the on-disk hydra binary has been replaced (an upgrade).
func infoPath(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, "daemon.info"), nil
}
