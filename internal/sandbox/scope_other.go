//go:build !linux

package sandbox

// Systemd user scopes are Linux-only; the systemd-invoking entry points are
// no-ops elsewhere so callers can invoke them unconditionally. The pure helpers
// (ScopeUnit, ScopeHash) live in scope_common.go and are shared across platforms.

func ScopesAvailable() bool                                      { return false }
func WrapScope(unit string, spec *Spec, limits ScopeLimits) bool { return false }
func StopScope(unit string)                                      {}
func SweepOrphanScopes()                                         {}
