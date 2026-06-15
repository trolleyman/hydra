//go:build windows

package daemon

import (
	"context"
	"errors"
)

// EnsureRunning is not supported on Windows yet (the daemon control socket uses
// a unix domain socket; a named-pipe transport lands with the Windows backend).
func EnsureRunning(ctx context.Context, projectRoot string) error {
	return errors.New("hydra: the daemon is not yet supported on Windows")
}
