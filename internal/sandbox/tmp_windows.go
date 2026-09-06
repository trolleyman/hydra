//go:build windows

package sandbox

func SandboxTempDir(hostDir string) string { return hostDir }
