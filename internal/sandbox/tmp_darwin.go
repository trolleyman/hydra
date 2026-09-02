//go:build darwin

package sandbox

// SandboxTempDir returns the real per-head path used on macOS. Seatbelt cannot
// mount it over /tmp, so the process receives this path through its temp env.
func SandboxTempDir(hostDir string) string { return hostDir }
