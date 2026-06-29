package config

import "testing"

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
			name:        "no network config: unrestricted (filter off)",
			network:     nil,
			wantFilter:  false,
			wantEnabled: true,
		},
		{
			name:        "allowed_hosts set, toggle unset: inferred on",
			network:     &NetworkConfig{AllowedHosts: []string{"example.com"}},
			wantFilter:  true,
			wantEnabled: true,
			wantHosts:   1,
		},
		{
			name:        "no allowed_hosts, toggle unset: inferred off",
			network:     &NetworkConfig{},
			wantFilter:  false,
			wantEnabled: true,
		},
		{
			name:        "toggle true, empty list: deny-by-default (filter on, blocks all)",
			network:     &NetworkConfig{FilterEnabled: &tru},
			wantFilter:  true,
			wantEnabled: true,
		},
		{
			name:        "toggle false, hosts present: explicitly allow all",
			network:     &NetworkConfig{FilterEnabled: &fls, AllowedHosts: []string{"example.com"}},
			wantFilter:  false,
			wantEnabled: true,
			wantHosts:   1,
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
