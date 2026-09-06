package http

import (
	"os"
	"path/filepath"
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

	// Readable host paths are also agent-specific, but live under its sandbox.
	readable := filepath.Join(root, "host-sdk")
	if err := rememberApproval(root, "claude", "filesystem_read", readable); err != nil {
		t.Fatalf("rememberApproval(filesystem_read): %v", err)
	}
	cfg, err = config.LoadFile(config.GetProjectConfigPath(root))
	if err != nil || cfg == nil {
		t.Fatalf("reload config: %v", err)
	}
	ac = cfg.Agents["claude"]
	if ac.Sandbox == nil || !slices.Contains(ac.Sandbox.ReadablePaths, readable) {
		t.Errorf("filesystem grant not in per-agent [claude.sandbox].readable_paths: %+v", ac.Sandbox)
	}
}

func TestCanonicalReadablePath(t *testing.T) {
	root := t.TempDir()
	realDir := filepath.Join(root, "real")
	if err := os.Mkdir(realDir, 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "alias")
	if err := os.Symlink(realDir, link); err != nil {
		t.Fatal(err)
	}
	got, err := canonicalReadablePath(link)
	if err != nil {
		t.Fatal(err)
	}
	if got != realDir {
		t.Fatalf("canonical path = %q, want %q", got, realDir)
	}
	if _, err := canonicalReadablePath(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing path should be rejected")
	}
}

func TestPathWithin(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "tmp", "masked")
	if !pathWithin(filepath.Join(root, "child", "file"), root) || !pathWithin(root, root) {
		t.Fatal("pathWithin should include a directory and its descendants")
	}
	if pathWithin(root+"-other", root) {
		t.Fatal("path prefix without a component boundary must not match")
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
