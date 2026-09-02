//go:build linux

package sandbox

// SandboxTempDir returns the path a sandboxed process uses for its private
// temporary directory. Bubblewrap mounts the host directory at /tmp.
func SandboxTempDir(hostDir string) string {
	if hostDir == "" {
		return ""
	}
	return "/tmp"
}
