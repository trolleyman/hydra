package config

import (
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func strp(s string) *string { return &s }

// TestAllowedHostsUnionAcrossLayers checks that a per-agent
// [<agent>.sandbox.network] allowed/blocked-hosts list ADDS to the defaults-level
// [sandbox.network] list rather than replacing it, and that resolving twice does
// not mutate the shared defaults (the clone/alias hazard).
func TestAllowedHostsUnionAcrossLayers(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{Sandbox: &SandboxConfig{Network: &NetworkConfig{
			AllowedHosts: []string{"shared.example.com", "dup.example.com"},
			BlockedHosts: []string{"bad.example.com"},
		}}},
		Agents: map[string]AgentConfig{
			"claude": {Sandbox: &SandboxConfig{Network: &NetworkConfig{
				AllowedHosts: []string{"claude-only.example.com", "dup.example.com"},
				BlockedHosts: []string{"worse.example.com"},
			}}},
		},
	}

	_, _, _, _, net, _ := cfg.ResolveSandboxOptions("claude")
	wantAllowed := []string{"shared.example.com", "dup.example.com", "claude-only.example.com"}
	if !equalStrings(net.AllowedHosts, wantAllowed) {
		t.Errorf("claude AllowedHosts = %v, want %v (union, deduped)", net.AllowedHosts, wantAllowed)
	}
	wantBlocked := []string{"bad.example.com", "worse.example.com"}
	if !equalStrings(net.BlockedHosts, wantBlocked) {
		t.Errorf("claude BlockedHosts = %v, want %v (union)", net.BlockedHosts, wantBlocked)
	}

	// An agent with no override still sees the defaults list, unchanged by the
	// earlier claude resolve (no aliasing/mutation of cfg.Defaults).
	_, _, _, _, other, _ := cfg.ResolveSandboxOptions("gemini")
	if !equalStrings(other.AllowedHosts, []string{"shared.example.com", "dup.example.com"}) {
		t.Errorf("gemini AllowedHosts = %v, want the untouched defaults", other.AllowedHosts)
	}
}

// TestAllowedLoopbackPortsUnionAcrossLayers checks that the loopback-port
// allow-list merges like the host lists (per-agent adds to defaults, deduped)
// and lands on the resolved sandbox.NetworkPolicy.
func TestAllowedLoopbackPortsUnionAcrossLayers(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{Sandbox: &SandboxConfig{Network: &NetworkConfig{
			AllowedLoopbackPorts: []int{5037},
		}}},
		Agents: map[string]AgentConfig{
			"claude": {Sandbox: &SandboxConfig{Network: &NetworkConfig{
				AllowedLoopbackPorts: []int{5037, 8080},
			}}},
		},
	}

	_, _, _, _, net, _ := cfg.ResolveSandboxOptions("claude")
	if want := []int{5037, 8080}; !equalInts(net.AllowedLoopbackPorts, want) {
		t.Errorf("claude AllowedLoopbackPorts = %v, want %v (union, deduped)", net.AllowedLoopbackPorts, want)
	}

	// An agent with no override still sees the defaults list, unchanged by the
	// earlier claude resolve.
	_, _, _, _, other, _ := cfg.ResolveSandboxOptions("gemini")
	if want := []int{5037}; !equalInts(other.AllowedLoopbackPorts, want) {
		t.Errorf("gemini AllowedLoopbackPorts = %v, want the untouched defaults %v", other.AllowedLoopbackPorts, want)
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestResolveFilterHosts covers how the filter_enabled toggle (and its inferred
// default) resolves into sandbox.NetworkPolicy.FilterHosts.
func TestResolveFilterHosts(t *testing.T) {
	tru, fls := true, false
	cases := []struct {
		name        string
		network     *NetworkConfig
		wantFilter  bool
		wantEnabled bool
		wantHosts   int
	}{
		{
			name:        "no network config: hard default (filter on)",
			network:     nil,
			wantFilter:  true,
			wantEnabled: true,
		},
		{
			name:        "allowed_hosts set, nothing else: hard default (filter on)",
			network:     &NetworkConfig{AllowedHosts: []string{"example.com"}},
			wantFilter:  true,
			wantEnabled: true,
			wantHosts:   1,
		},
		{
			name:        "empty network config: hard default (filter on)",
			network:     &NetworkConfig{},
			wantFilter:  true,
			wantEnabled: true,
		},
		{
			name:        "legacy toggle true, empty list: deny-by-default (filter on, blocks all)",
			network:     &NetworkConfig{FilterEnabled: &tru},
			wantFilter:  true,
			wantEnabled: true,
		},
		{
			name:        "legacy toggle false, hosts present: explicitly allow all",
			network:     &NetworkConfig{FilterEnabled: &fls, AllowedHosts: []string{"example.com"}},
			wantFilter:  false,
			wantEnabled: true,
			wantHosts:   1,
		},
		{
			name:        "legacy enabled false: network off",
			network:     &NetworkConfig{Enabled: &fls},
			wantFilter:  false,
			wantEnabled: false,
		},
		{
			name:        `mode "off": network off`,
			network:     &NetworkConfig{Mode: strp("off")},
			wantFilter:  false,
			wantEnabled: false,
		},
		{
			name:        `mode "unrestricted": filter off`,
			network:     &NetworkConfig{Mode: strp("unrestricted")},
			wantFilter:  false,
			wantEnabled: true,
		},
		{
			name:        `mode "advisory": filter on`,
			network:     &NetworkConfig{Mode: strp("advisory")},
			wantFilter:  true,
			wantEnabled: true,
		},
		{
			name:        `mode "hard" supersedes legacy filter_enabled=false`,
			network:     &NetworkConfig{Mode: strp("hard"), FilterEnabled: &fls},
			wantFilter:  true,
			wantEnabled: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Config{Defaults: AgentConfig{Sandbox: &SandboxConfig{Network: tc.network}}}
			_, _, _, _, net, _ := cfg.ResolveSandboxOptions("claude")
			if net.FilterHosts != tc.wantFilter {
				t.Errorf("FilterHosts = %v, want %v", net.FilterHosts, tc.wantFilter)
			}
			if net.Enabled != tc.wantEnabled {
				t.Errorf("Enabled = %v, want %v", net.Enabled, tc.wantEnabled)
			}
			if len(net.AllowedHosts) != tc.wantHosts {
				t.Errorf("len(AllowedHosts) = %d, want %d", len(net.AllowedHosts), tc.wantHosts)
			}
		})
	}
}

// TestResolveNetworkMode covers the resolved Mode/Strict/BlockedHosts fields for
// the mode-based config, including the strict flag and the block-list carry.
func TestResolveNetworkMode(t *testing.T) {
	tru := true
	fls := false
	cases := []struct {
		name       string
		network    *NetworkConfig
		wantMode   sandbox.NetworkMode
		wantStrict bool
		wantBlock  int
	}{
		{"default (nil) is hard + strict", nil, sandbox.NetHard, true, 0},
		{"explicit advisory", &NetworkConfig{Mode: strp("advisory")}, sandbox.NetAdvisory, true, 0},
		{"hard strict", &NetworkConfig{Mode: strp("hard"), Strict: &tru}, sandbox.NetHard, true, 0},
		{"strict opt-out", &NetworkConfig{Mode: strp("hard"), Strict: &fls}, sandbox.NetHard, false, 0},
		{`"on" is a synonym for hard`, &NetworkConfig{Mode: strp("on")}, sandbox.NetHard, true, 0},
		{"blocked hosts carried", &NetworkConfig{BlockedHosts: []string{"evil.com", "*.tracker.io"}}, sandbox.NetHard, true, 2},
		{"legacy enabled=false is off", &NetworkConfig{Enabled: new(bool)}, sandbox.NetOff, true, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Config{Defaults: AgentConfig{Sandbox: &SandboxConfig{Network: tc.network}}}
			_, _, _, _, net, _ := cfg.ResolveSandboxOptions("claude")
			if net.Mode != tc.wantMode {
				t.Errorf("Mode = %q, want %q", net.Mode, tc.wantMode)
			}
			if net.Strict != tc.wantStrict {
				t.Errorf("Strict = %v, want %v", net.Strict, tc.wantStrict)
			}
			if len(net.BlockedHosts) != tc.wantBlock {
				t.Errorf("len(BlockedHosts) = %d, want %d", len(net.BlockedHosts), tc.wantBlock)
			}
		})
	}
}

// TestFilterEnabledRoundTrips ensures the toggle survives a Save/Load round-trip
// (it is rendered into the managed config and parsed back).
func TestFilterEnabledRoundTrips(t *testing.T) {
	tru := true
	cfg := Config{Defaults: AgentConfig{Sandbox: &SandboxConfig{
		Network: &NetworkConfig{FilterEnabled: &tru, AllowedHosts: []string{"docs.anthropic.com"}},
	}}}
	path := t.TempDir() + "/config.toml"
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}
	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	nw := loaded.Defaults.Sandbox.Network
	if nw == nil || nw.FilterEnabled == nil || !*nw.FilterEnabled {
		t.Fatalf("filter_enabled not round-tripped: %+v", nw)
	}
}
