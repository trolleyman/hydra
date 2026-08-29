//go:build windows

package daemon

import (
	"braces.dev/errtrace"
	"context"
	"errors"
)

// EnsureRunning is not supported on Windows yet (the daemon control socket uses
// a unix domain socket; a named-pipe transport lands with the Windows backend).
func EnsureRunning(ctx context.Context, projectRoot string) error {
	return errtrace.Wrap(errors.New("hydra: the daemon is not yet supported on Windows"))
}

// EnsureDesktopRunning uses the Windows launcher once it is implemented.
func EnsureDesktopRunning(ctx context.Context, projectRoot string) error {
	return errtrace.Wrap(EnsureRunning(ctx, projectRoot))
}
