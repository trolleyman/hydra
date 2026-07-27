package config

import (
	"strings"
	"testing"
)

func TestResolvePolicyDefaults(t *testing.T) {
	// Unset → gate enabled (the protective default), empty allow-lists.
	p := (Config{}).ResolvePolicy("claude")
	if !p.IsGateEnabled() {
		t.Error("gate should default to enabled when unset")
	}
	if len(p.MCPAllowed) != 0 || len(p.MCPToolsAllowed) != 0 {
		t.Errorf("allow-lists should default empty: %+v", p)
	}
}

func TestResolvePolicyMergesDefaultsAndAgent(t *testing.T) {
	off := false
	cfg := Config{
		Defaults: AgentConfig{Policy: &PolicyConfig{MCPAllowed: []string{"github"}}},
		Agents: map[string]AgentConfig{
			"claude": {Policy: &PolicyConfig{
				GateEnabled:     &off,
				MCPToolsAllowed: []string{"linear__create_issue"},
			}},
		},
	}
	p := cfg.ResolvePolicy("claude")
	// Agent override wins for gate_enabled and mcp_tools_allowed; defaults supply
	// mcp_allowed (the agent didn't set it, so it inherits).
	if p.IsGateEnabled() {
		t.Error("agent gate_enabled=false should win")
	}
	if len(p.MCPAllowed) != 1 || p.MCPAllowed[0] != "github" {
		t.Errorf("mcp_allowed should inherit from defaults: %+v", p.MCPAllowed)
	}
	if len(p.MCPToolsAllowed) != 1 || p.MCPToolsAllowed[0] != "linear__create_issue" {
		t.Errorf("mcp_tools_allowed should come from agent: %+v", p.MCPToolsAllowed)
	}
	// A different agent inherits only the defaults.
	g := cfg.ResolvePolicy("gemini")
	if !g.IsGateEnabled() {
		t.Error("gemini gate should inherit the enabled default")
	}
	if len(g.MCPAllowed) != 1 {
		t.Errorf("gemini should inherit defaults mcp_allowed: %+v", g.MCPAllowed)
	}
}

func TestResolveGitIsolation(t *testing.T) {
	// Unset -> off (fail-open to today's behaviour).
	if got := (PolicyConfig{}).ResolveGitIsolation(); got != "off" {
		t.Errorf("unset git_isolation = %q, want off", got)
	}
	// Valid values pass through; an unrecognized one falls back to off.
	for in, want := range map[string]string{
		"refs": "refs", "readonly": "readonly", "off": "off",
		"clone": "off", "bogus": "off", "": "off",
	} {
		s := in
		if got := string((PolicyConfig{GitIsolation: &s}).ResolveGitIsolation()); got != want {
			t.Errorf("ResolveGitIsolation(%q) = %q, want %q", in, got, want)
		}
	}
	// Agent override wins over the defaults layer, per-agent-type.
	def, agent := "off", "readonly"
	cfg := Config{
		Defaults: AgentConfig{Policy: &PolicyConfig{GitIsolation: &def}},
		Agents:   map[string]AgentConfig{"claude": {Policy: &PolicyConfig{GitIsolation: &agent}}},
	}
	if got := cfg.ResolvePolicy("claude").ResolveGitIsolation(); got != "readonly" {
		t.Errorf("claude git_isolation = %q, want readonly (agent override)", got)
	}
	if got := cfg.ResolvePolicy("gemini").ResolveGitIsolation(); got != "off" {
		t.Errorf("gemini git_isolation = %q, want off (defaults)", got)
	}
}

func TestPolicyRenderRoundTrip(t *testing.T) {
	// The empty template documents the policy defaults (commented-out).
	tmpl := renderConfig(nil, Config{})
	for _, want := range []string{"[policy]", "# gate_enabled = true", "# mcp_allowed = []", "# mcp_tools_allowed = []"} {
		if !strings.Contains(tmpl, want) {
			t.Errorf("template missing %q:\n%s", want, tmpl)
		}
	}
	// known_tools documents the built-in default set (a sample entry proves the list
	// is rendered, not just the empty key).
	if !strings.Contains(tmpl, "# known_tools = [") || !strings.Contains(tmpl, `"Bash"`) {
		t.Errorf("template missing documented known_tools default:\n%s", tmpl)
	}

	// A per-agent policy override round-trips through render→decode unchanged
	// (i.e. is not dropped on save).
	off := false
	cfg := Config{Agents: map[string]AgentConfig{
		"claude": {Policy: &PolicyConfig{GateEnabled: &off, MCPAllowed: []string{"github", "playwright"}}},
	}}
	out := renderConfig(nil, cfg)
	if !strings.Contains(out, "[claude.policy]") {
		t.Errorf("[claude.policy] not rendered:\n%s", out)
	}
	decoded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode rendered config: %v", err)
	}
	p := decoded.Agents["claude"].Policy
	if p == nil || p.GateEnabled == nil || *p.GateEnabled || len(p.MCPAllowed) != 2 {
		t.Errorf("claude policy lost on round-trip: %+v", p)
	}
}

func TestPolicySurvivesUnrelatedSave(t *testing.T) {
	// A hand-written [claude.policy] must survive a save that only touches other
	// settings (the renderer must not silently drop the managed-but-unedited table).
	existing := []byte(strings.Join([]string{
		"[claude.policy]",
		`mcp_allowed = ["github"]`,
		"",
	}, "\n"))
	cfg, err := decodeConfig(existing)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	out := renderConfig(existing, cfg)
	if !strings.Contains(out, "[claude.policy]") || !strings.Contains(out, `mcp_allowed = ["github"]`) {
		t.Errorf("policy table dropped on re-render:\n%s", out)
	}
}

func TestDefaultsLevelPolicy(t *testing.T) {
	// A top-level [policy] table is the defaults-level override.
	cfg, err := decodeConfig([]byte("[policy]\nmcp_allowed = [\"github\"]\n"))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Defaults.Policy == nil || len(cfg.Defaults.Policy.MCPAllowed) != 1 {
		t.Fatalf("defaults [policy] not decoded: %+v", cfg.Defaults.Policy)
	}
}
