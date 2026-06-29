package heads

import (
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

// TestStartEgressMode covers the mode startEgress records for each network
// posture. The filtering branch starts a real loopback proxy, so the test closes
// it via stopEgressProxy afterwards.
func TestStartEgressMode(t *testing.T) {
	t.Run("network off", func(t *testing.T) {
		id := "test-egress-off"
		defer stopEgressProxy(id)
		env, wrap := startEgress(id, sandbox.NetworkPolicy{Enabled: false})
		if env != nil || wrap != nil {
			t.Errorf("expected no proxy env/wrap for network-off, got env=%v wrap!=nil=%v", env, wrap != nil)
		}
		if got := EgressModeFor(id); got != EgressOff {
			t.Errorf("mode = %q, want %q", got, EgressOff)
		}
	})

	t.Run("filtering off: unrestricted", func(t *testing.T) {
		id := "test-egress-unrestricted"
		defer stopEgressProxy(id)
		// Filtering off even with hosts present (explicit allow-all).
		env, wrap := startEgress(id, sandbox.NetworkPolicy{Enabled: true, FilterHosts: false, AllowedHosts: []string{"example.com"}})
		if env != nil || wrap != nil {
			t.Errorf("expected no proxy env/wrap for unrestricted, got env=%v wrap!=nil=%v", env, wrap != nil)
		}
		if got := EgressModeFor(id); got != EgressUnrestricted {
			t.Errorf("mode = %q, want %q", got, EgressUnrestricted)
		}
	})

	t.Run("filtering on: starts proxy in a filtered mode", func(t *testing.T) {
		id := "test-egress-filtered"
		defer stopEgressProxy(id)
		env, _ := startEgress(id, sandbox.NetworkPolicy{Enabled: true, FilterHosts: true, AllowedHosts: []string{"example.com"}})
		if len(env) == 0 {
			t.Errorf("expected proxy env to be injected when filtering, got none")
		}
		switch got := EgressModeFor(id); got {
		case EgressHard, EgressAdvisory:
			// Either is valid depending on pasta/nft availability on the host.
		default:
			t.Errorf("mode = %q, want a filtered mode (%q or %q)", got, EgressHard, EgressAdvisory)
		}
	})

	t.Run("unknown head: no mode", func(t *testing.T) {
		if got := EgressModeFor("test-egress-never-started"); got != EgressNone {
			t.Errorf("mode = %q, want empty sentinel", got)
		}
	})
}
