package heads

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/gate"
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

// TestEgressApproverRestoresPriorStatus verifies that parking a head for an egress
// approval and then resolving it puts the head back into the status it held before
// the park (finished, waiting, ...) rather than force-writing "running". A parked
// connection can come from a background process while the agent itself is idle or
// done, so forcing "running" would leave the head looking busy forever.
func TestEgressApproverRestoresPriorStatus(t *testing.T) {
	newApprover := func() *egressApprover {
		return &egressApprover{projectRoot: t.TempDir(), id: "h1", agentType: sandbox.AgentTypeClaude}
	}
	str := func(s string) *string { return &s }

	t.Run("restores a finished head", func(t *testing.T) {
		e := newApprover()
		if err := WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
			Status: api.Finished, Timestamp: "2020-01-01T00:00:00Z", LastMessage: str("all done"),
		}); err != nil {
			t.Fatal(err)
		}

		e.enter("wants to connect to \"example.com\"")
		if got := ReadAgentStatus(e.projectRoot, e.id); got == nil || got.Status != api.NeedsInput {
			t.Fatalf("during park: status = %v, want needs_input", got)
		}

		e.leave()
		got := ReadAgentStatus(e.projectRoot, e.id)
		if got == nil || got.Status != api.Finished {
			t.Fatalf("after resolve: status = %v, want finished restored", got)
		}
		if got.LastMessage == nil || *got.LastMessage != "all done" {
			t.Errorf("last_message not preserved: %v", got.LastMessage)
		}
		if got.Timestamp == "2020-01-01T00:00:00Z" {
			t.Error("timestamp should advance so the poller notices the transition")
		}
	})

	t.Run("falls back to running when there was no prior status", func(t *testing.T) {
		e := newApprover() // no status.json written
		e.enter("wants to connect to \"example.com\"")
		e.leave()
		got := ReadAgentStatus(e.projectRoot, e.id)
		if got == nil || got.Status != api.Running {
			t.Fatalf("status = %v, want running fallback", got)
		}
	})

	t.Run("does not clobber a newer non-approval status", func(t *testing.T) {
		e := newApprover()
		if err := WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
			Status: api.Waiting, Timestamp: "2020-01-01T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
		e.enter("wants to connect to \"example.com\"")
		// Simulate the agent's own hook advancing the status while parked.
		if err := WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
			Status: api.Running, Timestamp: "2020-01-02T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
		e.leave()
		got := ReadAgentStatus(e.projectRoot, e.id)
		if got == nil || got.Status != api.Running {
			t.Fatalf("status = %v, want the newer running status left in place", got)
		}
	})

	t.Run("last of several parked hosts restores once", func(t *testing.T) {
		e := newApprover()
		if err := WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
			Status: api.Finished, Timestamp: "2020-01-01T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
		e.enter("host a")
		e.enter("host b")
		e.leave() // one still parked -> stay in the wait
		if got := ReadAgentStatus(e.projectRoot, e.id); got == nil || got.Status != api.NeedsInput {
			t.Fatalf("with one host still parked: status = %v, want needs_input", got)
		}
		e.leave() // last one -> restore
		if got := ReadAgentStatus(e.projectRoot, e.id); got == nil || got.Status != api.Finished {
			t.Fatalf("after last resolve: status = %v, want finished restored", got)
		}
	})

	// A stale policy-approval status left on disk must not be captured as the
	// "prior" state - otherwise resolving would restore the head into needs_input.
	t.Run("ignores a stale policy-approval status when capturing", func(t *testing.T) {
		e := newApprover()
		nt := gate.NotificationPolicyApproval
		if err := WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
			Status: api.NeedsInput, Timestamp: "2020-01-01T00:00:00Z", NotificationType: &nt,
		}); err != nil {
			t.Fatal(err)
		}
		e.enter("host a")
		e.leave()
		got := ReadAgentStatus(e.projectRoot, e.id)
		if got == nil || got.Status != api.Running {
			t.Fatalf("status = %v, want running fallback (stale approval not restored)", got)
		}
	})
}
