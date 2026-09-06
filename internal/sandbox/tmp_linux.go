//go:build linux

package sandbox

// SandboxTempDir returns the path a sandboxed process uses for its private
// temporary directory. Bubblewrap mounts the host directory at /tmp.
func SandboxTempDir(hostDir string) string {
	// Every Linux sandbox receives a fresh tmpfs at /tmp, including one-shot
	// test/artifact/preview commands that do not need a host-backed temp dir.
	return "/tmp"
}
