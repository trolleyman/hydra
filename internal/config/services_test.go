package config

import (
	"strings"
	"testing"
)

func intPtr(i int) *int { return &i }
func boolPtr(b bool) *bool { return &b }

// TestEnabledFlagRoundTrip checks that enabled = false survives a render -> parse
// round-trip for both services and artifacts, that an absent flag means enabled
// (IsEnabled true), and that the default (enabled) emits no `enabled` line.
func TestEnabledFlagRoundTrip(t *testing.T) {
	cfg := Config{
		Services: []ServiceScript{
			{Name: "off-svc", Command: "true", Enabled: boolPtr(false)},
			{Name: "on-svc", Command: "true"},
		},
		Artifacts: []ArtifactScript{
			{Name: "off-art", Command: "true", Enabled: boolPtr(false)},
			{Name: "on-art", Command: "true"},
		},
	}

	tomlStr := renderConfig(nil, cfg)
	// Count whole-line `enabled = false` matches only — not commented defaults or
	// other keys that end in "enabled" (e.g. filter_enabled).
	active := 0
	for line := range strings.SplitSeq(tomlStr, "\n") {
		if strings.TrimSpace(line) == "enabled = false" {
			active++
		}
	}
	if active != 2 {
		t.Fatalf("expected exactly 2 `enabled = false` lines (one per disabled item), got %d:\n%s", active, tomlStr)
	}

	parsed, err := decodeConfig([]byte(tomlStr))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(parsed.Services) != 2 || len(parsed.Artifacts) != 2 {
		t.Fatalf("expected 2 services + 2 artifacts, got %d + %d", len(parsed.Services), len(parsed.Artifacts))
	}
	if parsed.Services[0].IsEnabled() {
		t.Fatalf("off-svc should be disabled: %+v", parsed.Services[0])
	}
	if !parsed.Services[1].IsEnabled() || parsed.Services[1].Enabled != nil {
		t.Fatalf("on-svc should be enabled with no explicit flag: %+v", parsed.Services[1])
	}
	if parsed.Artifacts[0].IsEnabled() {
		t.Fatalf("off-art should be disabled: %+v", parsed.Artifacts[0])
	}
	if !parsed.Artifacts[1].IsEnabled() || parsed.Artifacts[1].Enabled != nil {
		t.Fatalf("on-art should be enabled with no explicit flag: %+v", parsed.Artifacts[1])
	}
}

// TestPreExitScriptRoundTrip checks that a pre_exit_script survives a
// render -> parse round-trip and resolves for an agent.
func TestPreExitScriptRoundTrip(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{
			Sandbox: &SandboxConfig{PreExitScript: strPtr("emu-release.sh\necho done")},
		},
	}

	tomlStr := renderConfig(nil, cfg)
	if !strings.Contains(tomlStr, "pre_exit_script = ") {
		t.Fatalf("rendered config missing pre_exit_script:\n%s", tomlStr)
	}

	parsed, err := decodeConfig([]byte(tomlStr))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := parsed.ResolvePreExitScript("claude"); got != "emu-release.sh\necho done" {
		t.Fatalf("resolved preExit mismatch: %q", got)
	}
}

// TestPreExitScriptAgentOverride checks the per-agent override wins.
func TestPreExitScriptAgentOverride(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{Sandbox: &SandboxConfig{PreExitScript: strPtr("default")}},
		Agents: map[string]AgentConfig{
			"claude": {Sandbox: &SandboxConfig{PreExitScript: strPtr("claude-only")}},
		},
	}
	if got := cfg.ResolvePreExitScript("claude"); got != "claude-only" {
		t.Fatalf("claude override: got %q", got)
	}
	if got := cfg.ResolvePreExitScript("gemini"); got != "default" {
		t.Fatalf("gemini inherits default: got %q", got)
	}
}

// TestServicesRoundTrip checks [[services]] blocks survive a render -> parse
// round-trip with all fields intact.
func TestServicesRoundTrip(t *testing.T) {
	cfg := Config{
		Services: []ServiceScript{
			{Name: "emu-pool", Command: "scripts/emu-pool.sh up 3 --foreground", Host: true, MaxRestarts: intPtr(5)},
			{Name: "indexer", Command: "bun run indexer"},
		},
	}

	tomlStr := renderConfig(nil, cfg)
	if !strings.Contains(tomlStr, "[[services]]") {
		t.Fatalf("rendered config missing [[services]]:\n%s", tomlStr)
	}

	parsed, err := decodeConfig([]byte(tomlStr))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(parsed.Services) != 2 {
		t.Fatalf("expected 2 services, got %d: %+v", len(parsed.Services), parsed.Services)
	}
	emu := parsed.Services[0]
	if emu.Name != "emu-pool" || emu.Command != "scripts/emu-pool.sh up 3 --foreground" || !emu.Host {
		t.Fatalf("emu-pool round-trip mismatch: %+v", emu)
	}
	if emu.MaxRestarts == nil || *emu.MaxRestarts != 5 {
		t.Fatalf("emu-pool max_restarts mismatch: %+v", emu.MaxRestarts)
	}
	idx := parsed.Services[1]
	if idx.Name != "indexer" || idx.Host || idx.MaxRestarts != nil {
		t.Fatalf("indexer round-trip mismatch: %+v", idx)
	}
}

// TestServicesNotParsedAsArtifacts guards the renderer against the historical
// "all array tables are artifacts" behaviour: a file holding BOTH [[artifacts]]
// and [[services]] must keep them distinct across a defaults-only re-render
// (nil Artifacts/Services = preserve mode).
func TestServicesNotParsedAsArtifacts(t *testing.T) {
	src := `[[artifacts]]
name = "shots"
command = "bun run shots"

[[services]]
name = "emu-pool"
command = "emu up"
host = true
`
	parsed, err := decodeConfig([]byte(src))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(parsed.Artifacts) != 1 || parsed.Artifacts[0].Name != "shots" {
		t.Fatalf("artifacts mis-parsed: %+v", parsed.Artifacts)
	}
	if len(parsed.Services) != 1 || parsed.Services[0].Name != "emu-pool" || !parsed.Services[0].Host {
		t.Fatalf("services mis-parsed: %+v", parsed.Services)
	}

	// A defaults-only save (nil lists) preserves both blocks verbatim and does
	// not duplicate the service into the artifacts section. Count exact header
	// lines (the doc blocks also mention "[[artifacts]]:"/"[[services]]:").
	countHeaders := func(text, header string) int {
		n := 0
		for _, ln := range strings.Split(text, "\n") {
			if strings.TrimSpace(ln) == header {
				n++
			}
		}
		return n
	}
	rendered := renderConfig([]byte(src), Config{})
	if countHeaders(rendered, "[[artifacts]]") != 1 {
		t.Fatalf("expected exactly one [[artifacts]] header after preserve render:\n%s", rendered)
	}
	if countHeaders(rendered, "[[services]]") != 1 {
		t.Fatalf("expected exactly one [[services]] header after preserve render:\n%s", rendered)
	}
	reparsed, err := decodeConfig([]byte(rendered))
	if err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	if len(reparsed.Artifacts) != 1 || len(reparsed.Services) != 1 {
		t.Fatalf("preserve render lost a block: arts=%+v svcs=%+v", reparsed.Artifacts, reparsed.Services)
	}
}

// TestServicesAuthoritativeDelete checks an explicit empty list clears services.
func TestServicesAuthoritativeDelete(t *testing.T) {
	src := `[[services]]
name = "emu-pool"
command = "emu up"
`
	rendered := renderConfig([]byte(src), Config{Services: []ServiceScript{}})
	parsed, err := decodeConfig([]byte(rendered))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(parsed.Services) != 0 {
		t.Fatalf("expected services cleared, got %+v", parsed.Services)
	}
}
