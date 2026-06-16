//go:build windows

package usage

import (
	"context"
	"time"
)

// HostEnv is unused on Windows (Probe is stubbed) but kept for API parity.
func HostEnv() []string { return nil }

// Probe is not supported on Windows, where Hydra's sandbox/session stack is
// itself stubbed. It reports an unavailable snapshot rather than erroring.
func Probe(_ context.Context, _, _ string, _ []string) (Snapshot, error) {
	return Snapshot{CapturedAt: time.Now(), Error: "Claude usage probe is not supported on Windows"}, nil
}
