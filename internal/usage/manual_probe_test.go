//go:build !windows

package usage

import (
	"context"
	"os"
	"os/exec"
	"testing"
)

// TestManualProbe drives the real Claude CLI. The `/usage` screen is not a
// contract - Anthropic restyles it - so when the parser stops finding quota,
// this is how you see what the screen looks like now:
//
//	HYDRA_USAGE_PROBE=1 go test ./internal/usage -run TestManualProbe -v
//
// It is skipped by default (it launches a CLI and needs a logged-in account).
// HYDRA_USAGE_PROBE_DIR picks the working directory, and HYDRA_USAGE_PROBE_VARIANT
// is "screen-reader" or "tui" to exercise one invocation directly instead of
// going through Probe's flag-support fallback.
func TestManualProbe(t *testing.T) {
	if os.Getenv("HYDRA_USAGE_PROBE") == "" {
		t.Skip("set HYDRA_USAGE_PROBE=1 to probe the real Claude CLI")
	}
	path, err := exec.LookPath("claude")
	if err != nil {
		t.Skipf("no claude CLI on PATH: %v", err)
	}
	dir := os.Getenv("HYDRA_USAGE_PROBE_DIR")
	if dir == "" {
		if dir, err = os.Getwd(); err != nil {
			t.Fatal(err)
		}
	}

	var snap Snapshot
	switch v := os.Getenv("HYDRA_USAGE_PROBE_VARIANT"); v {
	case "":
		snap, err = Probe(context.Background(), "claude", dir, HostEnv())
	case screenReaderVariant.name, legacyTUIVariant.name:
		variant := screenReaderVariant
		if v == legacyTUIVariant.name {
			variant = legacyTUIVariant
		}
		var screen string
		snap, screen, err = probeOnce(context.Background(), path, dir, HostEnv(), variant)
		t.Logf("screen:\n%s", screenPreview(screen))
	default:
		t.Fatalf("unknown HYDRA_USAGE_PROBE_VARIANT %q", v)
	}
	if err != nil {
		t.Fatalf("probe: %v", err)
	}

	t.Logf("available=%t complete=%t tier=%q error=%q", snap.Available, snap.Complete(), snap.AccountTier, snap.Error)
	t.Logf("session: used=%v resetsAt=%v text=%q", fmtPct(snap.SessionPercentUsed), snap.SessionResetsAt, snap.SessionResetText)
	t.Logf("weekly:  used=%v text=%q", fmtPct(snap.WeeklyPercentUsed), snap.WeeklyResetText)
	if !snap.Available {
		t.Errorf("probe produced no usable quota: %s", snap.Error)
	}
}

func fmtPct(v *float64) any {
	if v == nil {
		return "<nil>"
	}
	return *v
}
