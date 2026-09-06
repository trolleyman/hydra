//go:build darwin

package egress

import (
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestPrepareHardBoundaryDarwinConfiguresSeatbeltProxyPort(t *testing.T) {
	policy := sandbox.NetworkPolicy{
		Mode:                 sandbox.NetHard,
		Enabled:              true,
		FilterHosts:          true,
		AllowedLoopbackPorts: []int{5037},
	}
	boundary, ok := PrepareHardBoundary("head", 43123, &policy, 38913)
	if !ok {
		t.Fatal("Darwin hard boundary reported unavailable")
	}
	if boundary.ProxyURL != "http://127.0.0.1:43123" || boundary.Wrap != nil {
		t.Fatalf("boundary = %+v", boundary)
	}
	if boundary.Mechanism != "Seatbelt loopback-only" {
		t.Errorf("mechanism = %q", boundary.Mechanism)
	}
	if policy.HardProxyPort != 43123 {
		t.Errorf("HardProxyPort = %d, want 43123", policy.HardProxyPort)
	}
	if policy.HardInboundPort != 38913 {
		t.Errorf("HardInboundPort = %d, want 38913", policy.HardInboundPort)
	}
}
