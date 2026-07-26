// Package scope is the single seam where a non-agent workload runner (artifact
// generator, preview server, long-running service, test runner) wraps its launch
// spec in a transient systemd scope carrying the project's configured cgroup
// resource limits. Centralising it keeps the "resolve [resources] and apply it"
// policy in one place instead of copy-pasted at every runner.
//
// The agent head path is deliberately NOT routed through here: it resolves its
// limits into StartOptions and wraps the supervisor bwrap with extra fork
// handling (LockOSThread + Pdeathsig), so it stays in internal/heads.
package scope

import (
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// Apply rewrites spec to run under a transient systemd scope named unit, applying
// projectRoot's configured resource limits (CPU/IO weight plus any hard caps).
// It is best-effort: a no-op where systemd scopes are unavailable, and it never
// fails a spawn (a config load error falls back to the default limits). The
// caller owns the unit name and must sandbox.StopScope(unit) on teardown to reap
// the cgroup.
func Apply(projectRoot, unit string, spec *sandbox.Spec) {
	limits, _ := config.Load(projectRoot)
	sandbox.WrapScope(unit, spec, limits.ResolveResourceLimits())
}
