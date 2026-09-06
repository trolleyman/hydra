package heads

import (
	"os"
	"path/filepath"
	"runtime"
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

	t.Run("advisory: starts the filtering proxy", func(t *testing.T) {
		id := "test-egress-filtered"
		defer stopEgressProxy(id)
		env, _ := startEgress("", id, sandbox.AgentTypeClaude, &sandbox.NetworkPolicy{Mode: sandbox.NetAdvisory, Enabled: true, FilterHosts: true, AllowedHosts: []string{"example.com"}})
		if len(env) == 0 {
			t.Errorf("expected proxy env to be injected when filtering, got none")
		}
		if got := EgressModeFor(id); got != EgressAdvisory {
			t.Errorf("mode = %q, want %q", got, EgressAdvisory)
		}
	})

	t.Run("hard: locked boundary, or fail closed without the tooling", func(t *testing.T) {
		id := "test-egress-hard"
		defer stopEgressProxy(id)
		pol := sandbox.NetworkPolicy{Mode: sandbox.NetHard, Enabled: true, FilterHosts: true, AllowedHosts: []string{"example.com"}}
		env, wrap := startEgress("", id, sandbox.AgentTypeClaude, &pol)
		switch got := EgressModeFor(id); got {
		case EgressHard:
			if len(env) == 0 || !pol.Enabled {
				t.Errorf("active hard mode: expected proxy env + enabled policy, got env=%v Enabled=%v", env, pol.Enabled)
			}
			if runtime.GOOS == "linux" && wrap == nil {
				t.Error("Linux hard mode must wrap the sandbox in pasta+nft")
			}
			if runtime.GOOS == "darwin" && (wrap != nil || pol.HardProxyPort == 0) {
				t.Errorf("Darwin hard mode must use a Seatbelt proxy port without an argv wrap: wrap=%v port=%d", wrap != nil, pol.HardProxyPort)
			}
		case EgressOff:
			// Hard never degrades: without pasta/nft the head fails closed.
			if env != nil || wrap != nil || pol.Enabled {
				t.Errorf("hard mode without tooling must fail closed, got env=%v wrap!=nil=%v Enabled=%v", env, wrap != nil, pol.Enabled)
			}
		default:
			t.Fatalf("hard mode recorded unexpected posture %q", got)
		}
	})

	t.Run("unknown head: no mode", func(t *testing.T) {
		if got := EgressModeFor("test-egress-never-started"); got != EgressNone {
			t.Errorf("mode = %q, want empty sentinel", got)
		}
	})
}

// TestEgressProxyEnvFor covers the co-tenant proxy env a sandboxed bash shell
// inherits from the head's already-running proxy: present (with HTTP_PROXY) in a
// filtered mode, empty for off/unrestricted/unknown.
func TestEgressProxyEnvFor(t *testing.T) {
	hasHTTPProxy := func(env []string) bool {
		for _, e := range env {
			if len(e) >= 11 && e[:11] == "HTTP_PROXY=" {
				return true
			}
		}
		return false
	}

	t.Run("unknown head: nil", func(t *testing.T) {
		if env := EgressProxyEnvFor("test-proxyenv-unknown"); env != nil {
			t.Errorf("expected nil for unknown head, got %v", env)
		}
	})

	t.Run("unrestricted: nil (no proxy to route through)", func(t *testing.T) {
		id := "test-proxyenv-unrestricted"
		defer stopEgressProxy(id)
		startEgress("", id, sandbox.AgentTypeClaude, &sandbox.NetworkPolicy{Mode: sandbox.NetUnrestricted, Enabled: true, FilterHosts: false})
		if env := EgressProxyEnvFor(id); env != nil {
			t.Errorf("expected nil for unrestricted, got %v", env)
		}
	})

	t.Run("filtered: routes through the running proxy", func(t *testing.T) {
		id := "test-proxyenv-filtered"
		defer stopEgressProxy(id)
		startEgress("", id, sandbox.AgentTypeClaude, &sandbox.NetworkPolicy{Mode: sandbox.NetAdvisory, Enabled: true, FilterHosts: true, AllowedHosts: []string{"example.com"}})
		env := EgressProxyEnvFor(id)
		if !hasHTTPProxy(env) {
			t.Errorf("expected HTTP_PROXY in co-tenant env for a filtered head, got %v", env)
		}
	})
}

// TestStartEgressKeyedSeparatesProxyFromApproval verifies a standalone sandboxed
// shell's own egress is keyed by the shell id (its proxy/mode/port), independent of
// the head id, and that StopShellEgress tears it down.
func TestStartEgressKeyedSeparatesProxyFromApproval(t *testing.T) {
	shellID, headID := ShellSessionID("h1", true, "tab1"), "h1"
	startEgressKeyed("", shellID, headID, sandbox.AgentTypeBash, &sandbox.NetworkPolicy{Mode: sandbox.NetAdvisory, Enabled: true, FilterHosts: true, AllowedHosts: []string{"example.com"}})

	// The proxy/mode live under the shell id, not the head id.
	if got := EgressModeFor(shellID); got != EgressAdvisory {
		t.Errorf("shell mode = %q, want %q", got, EgressAdvisory)
	}
	if got := EgressModeFor(headID); got != EgressNone {
		t.Errorf("head id must not carry the shell's proxy, got mode %q", got)
	}
	if rememberedEgressPort(shellID) == 0 {
		t.Error("expected a remembered proxy port for the shell")
	}

	// StopShellEgress (the ephemeral-exit hook) clears both proxy and port.
	StopShellEgress(shellID)
	if got := EgressModeFor(shellID); got != EgressNone {
		t.Errorf("after StopShellEgress: mode = %q, want cleared", got)
	}
	if rememberedEgressPort(shellID) != 0 {
		t.Error("after StopShellEgress: remembered port should be cleared")
	}
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
