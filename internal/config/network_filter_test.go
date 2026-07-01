package config

import (
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func strp(s string) *string { return &s }

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
	cases := []struct {
		name       string
		network    *NetworkConfig
		wantMode   sandbox.NetworkMode
		wantStrict bool
		wantBlock  int
	}{
		{"default (nil) is hard", nil, sandbox.NetHard, false, 0},
		{"explicit advisory", &NetworkConfig{Mode: strp("advisory")}, sandbox.NetAdvisory, false, 0},
		{"hard strict", &NetworkConfig{Mode: strp("hard"), Strict: &tru}, sandbox.NetHard, true, 0},
		{"blocked hosts carried", &NetworkConfig{BlockedHosts: []string{"evil.com", "*.tracker.io"}}, sandbox.NetHard, false, 2},
		{"legacy enabled=false is off", &NetworkConfig{Enabled: new(bool)}, sandbox.NetOff, false, 0},
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
