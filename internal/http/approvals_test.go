package http

import (
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/gate"
)

// TestRememberApprovalHostGoesToDefaults verifies that a remembered WebFetch/egress
// host is persisted to the DEFAULTS-level [sandbox.network] allowed_hosts (shared by
// every agent), not the per-agent [<agent>.sandbox.network], while MCP grants stay
// per-agent.
func TestRememberApprovalHostGoesToDefaults(t *testing.T) {
	root := t.TempDir()

	for _, kind := range []string{"webfetch", "egress"} {
		host := kind + ".example.com"
		if err := rememberApproval(root, "claude", kind, host); err != nil {
			t.Fatalf("rememberApproval(%s): %v", kind, err)
		}
		cfg, err := config.LoadFile(config.GetProjectConfigPath(root))
		if err != nil || cfg == nil {
			t.Fatalf("reload config: %v", err)
		}
		// Host lives in the shared defaults-level network allow-list.
		if cfg.Defaults.Sandbox == nil || cfg.Defaults.Sandbox.Network == nil ||
			!slices.Contains(cfg.Defaults.Sandbox.Network.AllowedHosts, host) {
			t.Errorf("%s host %q not in defaults [sandbox.network] allowed_hosts: %+v", kind, host, cfg.Defaults.Sandbox)
		}
		// Not written under [claude.sandbox.network].
		if ac, ok := cfg.Agents["claude"]; ok && ac.Sandbox != nil && ac.Sandbox.Network != nil &&
			slices.Contains(ac.Sandbox.Network.AllowedHosts, host) {
			t.Errorf("%s host %q leaked into per-agent [claude.sandbox.network]", kind, host)
		}
	}

	// The rendered TOML uses the top-level section header, not the agent-prefixed one.
	raw, err := os.ReadFile(config.GetProjectConfigPath(root))
	if err != nil {
		t.Fatal(err)
	}
	if s := string(raw); strings.Contains(s, "[claude.sandbox.network]") {
		t.Errorf("config unexpectedly wrote [claude.sandbox.network]:\n%s", s)
	}

	// MCP grants remain per-agent.
	if err := rememberApproval(root, "claude", "mcp", "some-server"); err != nil {
		t.Fatalf("rememberApproval(mcp): %v", err)
	}
	cfg, err := config.LoadFile(config.GetProjectConfigPath(root))
	if err != nil || cfg == nil {
		t.Fatalf("reload config: %v", err)
	}
	ac, ok := cfg.Agents["claude"]
	if !ok || ac.Policy == nil || !slices.Contains(ac.Policy.MCPAllowed, "some-server") {
		t.Errorf("mcp grant not in per-agent [claude.policy].mcp_allowed: %+v", ac.Policy)
	}
}

func TestGrantHostForSessionUnblocksSiblingRequests(t *testing.T) {
	dir := t.TempDir()
	requests := []gate.Request{
		{ReqID: "chosen", Kind: "webfetch", Target: "example.com"},
		{ReqID: "sibling-fetch", Kind: "webfetch", Target: "example.com"},
		{ReqID: "sibling-egress", Kind: "egress", Target: "example.com"},
		{ReqID: "other", Kind: "webfetch", Target: "other.example"},
	}
	for _, request := range requests {
		if err := gate.WriteRequest(dir, request); err != nil {
			t.Fatal(err)
		}
	}
	grantHostForSession(dir, "chosen", "example.com")
	if !slices.Contains(gate.LoadGrantedHosts(dir), "example.com") {
		t.Fatal("one-shot host approval was not retained for the running session")
	}
	for _, id := range []string{"sibling-fetch", "sibling-egress"} {
		decision, ok, err := gate.ReadDecision(dir, id)
		if err != nil || !ok || decision.Decision != gate.Allow {
			t.Errorf("%s decision = %+v, ok=%v, err=%v", id, decision, ok, err)
		}
	}
	if _, ok, err := gate.ReadDecision(dir, "other"); err != nil || ok {
		t.Errorf("unrelated host decision ok=%v err=%v", ok, err)
	}
}
