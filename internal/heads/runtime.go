package heads

import "github.com/trolleyman/hydra/internal/sandbox"

// hydraRuntime describes the executable path used by generated hooks, MCP
// servers, and the per-head supervisor. Linux gives the host executable a fixed
// sandbox-visible bind target. Darwin stages a build-addressed immutable copy
// and uses its real host path directly.
type hydraRuntime struct {
	VisiblePath    string
	Bind           *sandbox.Bind
	ImmutablePaths []string
}
