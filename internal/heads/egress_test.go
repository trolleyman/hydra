package heads

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// TestStartEgressMode covers the mode startEgress records for each network
// posture. The filtering branch starts a real loopback proxy, so the test closes
// it via stopEgressProxy afterwards.
func TestStartEgressMode(t *testing.T) {
	t.Run("network off", func(t *testing.T) {
		id := "test-egress-off"
		defer stopEgressProxy(id)
		env, wrap := startEgress("", id, sandbox.AgentTypeClaude, &sandbox.NetworkPolicy{Mode: sandbox.NetOff, Enabled: false})
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
		env, wrap := startEgress("", id, sandbox.AgentTypeClaude, &sandbox.NetworkPolicy{Mode: sandbox.NetUnrestricted, Enabled: true, FilterHosts: false, AllowedHosts: []string{"example.com"}})
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
		env, _ := startEgress("", id, sandbox.AgentTypeClaude, &sandbox.NetworkPolicy{Mode: sandbox.NetHard, Enabled: true, FilterHosts: true, AllowedHosts: []string{"example.com"}})
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

// TestEgressLiveAllowedHost verifies the approver re-reads the on-disk config
// allow-list so a host added to config.toml AFTER a head launched is allowed
// without a respawn or a prompt. It also checks the built-in defaults are unioned
// in and that blocked_hosts still wins.
func TestEgressLiveAllowedHost(t *testing.T) {
	dir := t.TempDir()
	cfgPath := config.GetProjectConfigPath(dir)
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
		t.Fatal(err)
	}
	write := func(body string) {
		if err := os.WriteFile(cfgPath, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}

	e := &egressApprover{projectRoot: dir, id: "h1", agentType: sandbox.AgentTypeClaude}

	// No user allow-list yet: a built-in default (Claude gets *.anthropic.com) is
	// allowed; an arbitrary host is not.
	write("[sandbox.network]\nmode = \"hard\"\n")
	if !e.liveAllowedHost("api.anthropic.com") {
		t.Error("default *.anthropic.com host should be allowed")
	}
	if e.liveAllowedHost("drivemcp.googleapis.com") {
		t.Error("googleapis host should NOT be allowed before it's added")
	}

	// Add the host to config (as if the user just edited it): now allowed live, no
	// respawn.
	write("[sandbox.network]\nmode = \"hard\"\nallowed_hosts = [\"drivemcp.googleapis.com\"]\n")
	if !e.liveAllowedHost("drivemcp.googleapis.com") {
		t.Error("host added to config.toml should be allowed on re-read")
	}
	if e.liveAllowedHost("evil.example.com") {
		t.Error("unrelated host should still be denied")
	}

	// blocked_hosts overrides the allow-list.
	write("[sandbox.network]\nmode = \"hard\"\nallowed_hosts = [\"drivemcp.googleapis.com\"]\nblocked_hosts = [\"drivemcp.googleapis.com\"]\n")
	if e.liveAllowedHost("drivemcp.googleapis.com") {
		t.Error("blocked host must win over the allow-list")
	}
}
