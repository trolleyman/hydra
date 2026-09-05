package heads

import "github.com/trolleyman/hydra/internal/paths"

// headReadablePaths adds Hydra-owned inputs that every head can read on top of
// the user's configured grants. Keep this separate from DefaultSandboxConfig:
// the upload root is project-specific and cannot be resolved without the
// registered project context held by the heads package.
func headReadablePaths(projectRoot string, configured []string) []string {
	readable := append([]string(nil), configured...)
	return append(readable, paths.GetUploadsDirFromProjectRoot(projectRoot))
}
